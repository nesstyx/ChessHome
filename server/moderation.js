// ═══════════════════════════════════════════════════════════════
//  moderation.js — ужесточённая модерация
// ═══════════════════════════════════════════════════════════════
//  1. Каскад бана: бан аккаунта автоматически выкидывает человека из
//     клубов и из текущих/будущих турниров, чистит его сообщения в
//     клубных/турнирных чатах и снимает ещё не начавшиеся турниры,
//     которые он создал (если в них больше никто не записан).
//     Создавать турниры/клубы забаненный не может — см. authMiddleware
//     в core.js (забаненный отсекается на любом защищённом роуте).
//  2. Теневые комментарии: комментарии забаненных / тенево-забаненных
//     (и бана комментариев дневника) публикуются «как обычно», но
//     реально их видят только сам автор и админы.
//  3. Автомодерация: слежение за активностью (чат, ЛС, клубные и
//     турнирные чаты, комментарии). Подозрительное поведение —
//     однотипные сообщения, флуд, рассылка в личку, ссылки — попадает
//     флагом во вкладку «Автомодерация» админки, а решение (пропустить /
//     теневой бан / бан) принимает админ.
//  Файл подключается из routes.js и sockets.js (require кэшируется,
//  выполнится один раз) и сам регистрирует свои админ-роуты.
// ═══════════════════════════════════════════════════════════════

const {
  app, db, uuidv4, jwt, JWT_SECRET, getAuthToken,
  authMiddleware, requireAdmin,
  getUser, saveUser, rowToUser,
  clubs, saveClub, getClubChat, deleteClubChatMsgsByUser,
  tournaments, saveTournament, deleteTournamentFromDB, sanitizeTournament,
  tournamentChats, wipeTournamentChatMsgsByUser,
  io, emitToAdmins, findSocketByUsername, logAdminAction,
  removeUserChatMessages, bannedDevices, saveBanToDB,
} = require('./core');


// ═══════════════════════════════════════════════════════════════
//  Настройки автомодерации (всё можно подкрутить здесь)
// ═══════════════════════════════════════════════════════════════
const CFG = {
  NEW_ACCOUNT_MS:    3 * 24 * 3600 * 1000, // «новый» аккаунт — моложе 3 суток (порог строже)
  WINDOW_MS:         10 * 60 * 1000,       // окно наблюдения за сообщениями
  SIMILARITY:        0.8,                  // насколько похожи сообщения, чтобы считаться «однотипными» (0..1)
  MIN_NORM_LEN:      4,                    // слишком короткие сообщения («ок», «да») не считаем

  REPEAT_NEW:        3,  REPEAT_OLD:        5,   // сколько однотипных сообщений за окно
  CROSS_CHANNELS:    3,                            // одно и то же в N разных местах (чат/клуб/ЛС/комментарии)
  DM_RECIPIENTS_NEW: 3,  DM_RECIPIENTS_OLD: 5,   // одно и то же разным людям в личку
  FLOOD_WINDOW_MS:   60 * 1000,
  FLOOD_NEW:         8,  FLOOD_OLD:         15,  // сообщений за минуту
  LINKS_NEW:         2,  LINKS_OLD:         6,   // сообщений со ссылками за окно

  SKIP_WHITELIST_MS: 24 * 3600 * 1000,           // после «Пропустить» человека не флагаем 24 часа
};

const KIND_LABELS = {
  repeat:     'Однотипные сообщения',
  cross_post: 'Одно и то же в разных местах',
  dm_spam:    'Рассылка в личные сообщения',
  flood:      'Флуд (слишком часто)',
  links:      'Ссылки / реклама',
  ad:         'Реклама / подозрительный текст',
  content:    'Подозрительный контент (форум, блог, клуб…)',
};


// ═══════════════════════════════════════════════════════════════
//  Кэш «кого прятать» (забаненные / теневые / бан комментариев дневника)
//  Обновляется раз в 15 секунд и сразу — при бане через админку.
// ═══════════════════════════════════════════════════════════════
const MOD_SETS_TTL = 15000;
let modSets = { at: 0, banned: new Set(), shadow: new Set(), diary: new Set() };

async function getModSets(force = false) {
  if (!force && Date.now() - modSets.at < MOD_SETS_TTL) return modSets;
  try {
    const u = await db(`SELECT username_low, banned, shadow_banned FROM users WHERE banned = TRUE OR shadow_banned = TRUE`);
    const d = await db(`SELECT username_low FROM dev_diary_comment_bans`).catch(() => ({ rows: [] }));
    modSets = {
      at: Date.now(),
      banned: new Set(u.rows.filter(r => r.banned).map(r => r.username_low)),
      shadow: new Set(u.rows.filter(r => r.shadow_banned).map(r => r.username_low)),
      diary:  new Set(d.rows.map(r => r.username_low)),
    };
  } catch (e) {
    console.error('[Moderation] mod sets:', e.message);
    modSets.at = Date.now() - MOD_SETS_TTL + 3000; // повторим через 3 секунды
  }
  return modSets;
}
function invalidateModSets() { modSets.at = 0; }

function viewerFromReq(req) {
  const t = getAuthToken(req);
  if (!t) return null;
  try { return String(jwt.verify(t, JWT_SECRET).username || '').toLowerCase() || null; } catch { return null; }
}
async function isAdminName(low) {
  if (!low) return false;
  const u = await getUser(low).catch(() => null);
  return !!u && u.role === 'admin';
}

// Список ников (lowercase), чьи комментарии/посты этот зритель НЕ должен видеть.
// Сам автор видит свои, админ видит всё. scope='diary' добавляет ещё и тех,
// кому в дневнике разработки отдельно запретили комментировать.
async function commentExclusions(req, scope = 'all') {
  const s = await getModSets();
  const hidden = new Set([...s.banned, ...s.shadow]);
  if (scope === 'diary') for (const n of s.diary) hidden.add(n);
  if (!hidden.size) return [];
  const viewer = viewerFromReq(req);
  if (viewer) {
    if (await isAdminName(viewer)) return [];
    hidden.delete(viewer);
  }
  return [...hidden];
}

async function filterVisible(req, items, getAuthor, scope = 'all') {
  const ex = new Set(await commentExclusions(req, scope));
  if (!ex.size) return items;
  return items.filter(it => !ex.has(String(getAuthor(it) || '').toLowerCase()));
}

async function isAuthorVisible(req, author, scope = 'all') {
  const ex = await commentExclusions(req, scope);
  return !ex.includes(String(author || '').toLowerCase());
}


// ═══════════════════════════════════════════════════════════════
//  Каскад бана
// ═══════════════════════════════════════════════════════════════
// Идемпотентна: можно вызывать повторно. Возвращает, что именно сделано.
async function applyBanCascade(username) {
  const low = String(username || '').toLowerCase();
  const out = { clubs: 0, tournaments: 0, tournamentsCancelled: 0 };
  if (!low) return out;

  // ── Клубы: убираем из участников и админов, чистим его сообщения в клубном чате
  for (const club of clubs) {
    const inMembers = (club.members || []).some(m => String(m).toLowerCase() === low);
    const inAdmins  = (club.admins  || []).some(a => String(a).toLowerCase() === low);
    if (!inMembers && !inAdmins) continue;
    club.members = (club.members || []).filter(m => String(m).toLowerCase() !== low);
    club.admins  = (club.admins  || []).filter(a => String(a).toLowerCase() !== low);
    // Клуб не должен остаться без админа, если в нём ещё есть люди
    if (!club.admins.length && club.members.length) club.admins.push(club.members[0]);
    club.memberCount = club.members.length;
    try { await saveClub(club); } catch (e) { console.error('[Moderation] saveClub:', e.message); }
    try {
      const chat = getClubChat(club.id);
      for (let i = chat.length - 1; i >= 0; i--) if (String(chat[i].username || '').toLowerCase() === low) chat.splice(i, 1);
      await deleteClubChatMsgsByUser(club.id, low);
    } catch (e) { console.error('[Moderation] club chat cleanup:', e.message); }
    out.clubs++;
  }

  // ── Турниры: выходим из активных, чистим чат, снимаем его будущие турниры без других участников
  const now = Date.now();
  for (let i = tournaments.length - 1; i >= 0; i--) {
    const t = tournaments[i];
    if (t.endsAt && t.endsAt < now) continue; // завершённые не трогаем

    const others = (t.participants || []).filter(p => !p.left && String(p.username || '').toLowerCase() !== low);
    if (String(t.createdBy || '').toLowerCase() === low && t.startsAt > now && !others.length) {
      try {
        tournaments.splice(i, 1);
        await deleteTournamentFromDB(t.id);
        io.emit('tournament_deleted', t.id);
        out.tournamentsCancelled++;
      } catch (e) { console.error('[Moderation] cancel tournament:', e.message); }
      continue;
    }

    const p = (t.participants || []).find(x => String(x.username || '').toLowerCase() === low);
    if (p && !p.left) {
      p.waiting = false; p.left = true;
      try {
        await saveTournament(t);
        io.to(`tournament_${t.id}`).emit('tournament_update', sanitizeTournament(t));
      } catch (e) { console.error('[Moderation] tournament leave:', e.message); }
      out.tournaments++;
    }
    if (tournamentChats && tournamentChats.has(t.id)) {
      try { await wipeTournamentChatMsgsByUser(t.id, low); } catch {}
    }
  }
  return out;
}

// Полный бан аккаунта + мультиаккаунтов с того же устройства (логика прежнего
// /api/admin/ban, вынесена сюда, чтобы её же использовала автомодерация).
async function banUserFully(adminUsername, target, reason, opts = {}) {
  const accountOnly = !!opts.accountOnly; // бот баним только сам аккаунт: устройство и «соседей» решает человек
  const targetDevice = target.createdDeviceId;
  if (targetDevice && !accountOnly) { bannedDevices.add(targetDevice); await saveBanToDB(null, targetDevice); }

  const banOne = async (u, suffix) => {
    u.banned = true; u.banReason = reason + (suffix || '');
    await saveUser(u);
    await removeUserChatMessages(u.username).catch(e => console.error('[Ban] chat cleanup:', e.message));
    const sock = findSocketByUsername(u.username);
    if (sock) { sock.emit('error', 'Аккаунт заблокирован'); sock.disconnect(); }
  };

  const affected = [];
  if (!accountOnly) {
    const r = await db('SELECT * FROM users WHERE created_device_id = $1 AND role != $2', [targetDevice || '__none__', 'admin']);
    for (const row of r.rows) {
      const u = rowToUser(row);
      if (u.banned) continue;
      await banOne(u, u.username !== target.username ? ' (мультиаккаунт)' : '');
      affected.push(u.username);
    }
  }
  if (!target.banned && !affected.includes(target.username)) {
    await banOne(target, '');
    affected.push(target.username);
  }

  invalidateModSets();
  const cascade = { clubs: 0, tournaments: 0, tournamentsCancelled: 0 };
  for (const name of affected) {
    const c = await applyBanCascade(name);
    cascade.clubs += c.clubs; cascade.tournaments += c.tournaments; cascade.tournamentsCancelled += c.tournamentsCancelled;
  }
  await getModSets(true);

  await logAdminAction(adminUsername, 'ban', target.username, {
    reason, accountsBanned: affected.length, viaDeviceId: accountOnly ? null : (targetDevice || null), cascade,
    ...(opts.logExtra || {}),
  });
  return { accountsBanned: affected.length, accounts: affected, cascade };
}

// Подстраховка: если бан поставили в обход banUserFully (IP-бан, автобан чата и т.п.) —
// раз в минуту добиваем каскад для всех забаненных, которые ещё числятся в клубах/турнирах.
async function sweepBanned() {
  const { banned } = await getModSets();
  if (!banned.size) return;
  const todo = new Set();
  const now = Date.now();
  for (const c of clubs) for (const n of [...(c.members || []), ...(c.admins || [])]) if (banned.has(String(n).toLowerCase())) todo.add(n);
  for (const t of tournaments) {
    if (t.endsAt && t.endsAt < now) continue;
    for (const p of t.participants || []) if (!p.left && banned.has(String(p.username || '').toLowerCase())) todo.add(p.username);
    if (t.startsAt > now && banned.has(String(t.createdBy || '').toLowerCase())) todo.add(t.createdBy);
  }
  for (const n of todo) await applyBanCascade(n);
}
setInterval(() => { sweepBanned().catch(e => console.error('[Moderation] sweep:', e.message)); }, 60 * 1000).unref();


// ═══════════════════════════════════════════════════════════════
//  Автомодерация: детектор спама
// ═══════════════════════════════════════════════════════════════
const LINK_RE = /(https?:\/\/|www\.|t\.me\/|discord\.gg|vk\.com|instagram\.com|tiktok\.com|[a-z0-9-]+\.(?:ru|com|net|org|io|gg|me|xyz|top|club)\b)/i;

// ── Анализ текста на рекламу/спам (общий для чата и для BotModerator) ──
const SAFE_LINK_RE = /(chesshome\.pro|lichess\.org|chess\.com|youtube\.com|youtu\.be|wikipedia\.org|twitch\.tv|github\.com)/i;
const URL_RE = /(?:https?:\/\/|www\.|t\.me\/|discord\.gg\/|wa\.me\/|bit\.ly\/|vk\.cc\/)\S+/gi;
// «Сильные» признаки: сами по себе почти всегда реклама/запрещёнка
const AD_STRONG = [
  /казино|casino|1xbet|1хбет|мелбет|melbet|букмекер|беттинг/i,
  /ставк[аиу]\s+на\s+спорт|sports?\s*bet/i,
  /порно|porn|\bxxx\b|\b18\+|эскорт|интим[-\s]?услуг|проститут/i,
  /viagra|виагра|cialis|сиалис/i,
  /заработок\s+без\s+вложений|пассивн\w+\s+доход|быстр\w+\s+заработок|лёгк\w+\s+деньги|легк\w+\s+деньги/i,
  /накрутк\w+\s+(подписчик|лайк|просмотр)|купить\s+подписчик|подписчик\w*\s+(бесплатно|дёшево|дешево)/i,
  /airdrop|эйрдроп|криптообмен|обменник/i,
];
// «Средние»: подозрительны только вместе с другими признаками
const AD_MEDIUM = [
  /заработ(ок|ать|ай)/i, /инвестиц/i, /крипто/i, /промокод|promo\s*code/i, /бонус/i,
  /подпишись|подписывайся|переходи\s+по\s+ссылке|жми\s+на\s+ссылку/i,
  /скидк\w+\s+\d+\s*%/i, /работа\s+на\s+дому/i,
];
function analyzeText(text) {
  const s = String(text || '').slice(0, 20000);
  const reasons = [];
  let adPoints = 0;
  if (AD_STRONG.some(rx => rx.test(s))) { adPoints = 85; reasons.push('рекламные/запрещённые слова'); }
  else {
    const m = AD_MEDIUM.filter(rx => rx.test(s)).length;
    if (m) { adPoints = m >= 2 ? 50 : 25; reasons.push('подозрительные слова (' + m + ')'); }
  }
  const urls = (s.match(URL_RE) || []).filter(u => !SAFE_LINK_RE.test(u));
  const linkPoints = Math.min(45, urls.length * 15);
  if (urls.length) reasons.push('внешние ссылки (' + urls.length + ')');
  let obf = 0;
  if (/(.)\1{9,}/u.test(s)) { obf = 10; reasons.push('длинные повторы символов'); }
  return { score: adPoints + linkPoints + obf, adPoints, linkPoints, linkCount: urls.length, reasons };
}

// Хуки для BotModerator: вызываются при каждом «срабатывании» детектора чата
const spamHooks = [];
function onSpamEvent(fn) { spamHooks.push(fn); }
function notifySpam(ev) {
  for (const h of spamHooks) {
    try { Promise.resolve(h(ev)).catch(e => console.error('[Automod hook]', e.message)); }
    catch (e) { console.error('[Automod hook]', e.message); }
  }
}

function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+|www\.\S+/g, ' url ')
    .replace(/\d+/g, '#')
    .replace(/[^\p{L}#\s]/gu, '')
    .replace(/(.)\1{2,}/gu, '$1$1')
    .replace(/\s+/g, ' ')
    .trim();
}
function trigrams(s) {
  const set = new Set();
  if (s.length < 3) { if (s) set.add(s); return set; }
  for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
  return set;
}
function similarity(a, b) {
  if (a.norm === b.norm) return 1;
  if (!a.tri.size || !b.tri.size) return 0;
  let inter = 0;
  for (const x of a.tri) if (b.tri.has(x)) inter++;
  return inter / (a.tri.size + b.tri.size - inter);
}

const events = new Map();          // usernameLow -> [{t, norm, tri, ch, to, link, raw}]
const openFlags = new Map();       // `${low}:${kind}` -> flag id (пока status='new')
const pendingKeys = new Set();     // защита от двойной вставки при гонке
const skipUntil = new Map();       // usernameLow -> ts, до которого не флагаем (после «Пропустить»)
let stateLoaded = false;

async function loadState() {
  if (stateLoaded) return true;
  try {
    const r = await db(`SELECT id, username_low, kind FROM automod_flags WHERE status = 'new'`);
    for (const row of r.rows) openFlags.set(`${row.username_low}:${row.kind}`, row.id);
    const s = await db(`SELECT username_low, resolved_at FROM automod_flags WHERE status = 'skipped' AND resolved_at > $1`, [Date.now() - CFG.SKIP_WHITELIST_MS]);
    for (const row of s.rows) skipUntil.set(row.username_low, Number(row.resolved_at) + CFG.SKIP_WHITELIST_MS);
    stateLoaded = true;
  } catch (e) { /* таблица ещё создаётся — попробуем при следующем событии */ }
  return stateLoaded;
}
function clearOpenFlagKeys(low) {
  for (const k of [...openFlags.keys()]) if (k.startsWith(low + ':')) openFlags.delete(k);
}

async function raiseFlag(user, kind, info) {
  const low = user.username.toLowerCase();
  const key = `${low}:${kind}`;
  if (pendingKeys.has(key)) return;
  pendingKeys.add(key);
  try {
    const now = Date.now();
    const details = JSON.stringify(info);
    const existing = openFlags.get(key);
    if (existing) {
      await db(`UPDATE automod_flags SET details=$1, updated_at=$2 WHERE id=$3 AND status='new'`, [details, now, existing]);
      return;
    }
    const id = uuidv4();
    await db(`INSERT INTO automod_flags (id, username, username_low, kind, details, status, created_at, updated_at)
              VALUES ($1,$2,$3,$4,$5,'new',$6,$6)`, [id, user.username, low, kind, details, now]);
    openFlags.set(key, id);
    emitToAdmins('automod_flag', { id, username: user.username, kind, label: KIND_LABELS[kind] || kind }).catch(() => {});
  } finally { pendingKeys.delete(key); }
}

async function processEvent({ username, channel, text, target }) {
  if (!username || typeof text !== 'string') return;
  if (!(await loadState())) return;
  const low = String(username).toLowerCase();

  const skip = skipUntil.get(low);
  if (skip && skip > Date.now()) return;

  const user = await getUser(low);
  if (!user || user.role === 'admin' || user.banned || user.shadowBanned) return;

  const raw = text.trim();
  if (raw.length < 2) return;
  const now = Date.now();
  let created = Number(user.createdAt) || 0;
  if (created && created < 1e11) created *= 1000;          // секунды -> мс на всякий случай
  const isNew = created ? (now - created < CFG.NEW_ACCOUNT_MS) : false;

  const norm = normalize(raw);
  const ev = {
    t: now, norm, tri: trigrams(norm), ch: String(channel || 'other'),
    to: target ? String(target).toLowerCase() : null,
    link: LINK_RE.test(raw), raw: raw.slice(0, 200),
  };
  let arr = (events.get(low) || []).filter(e => now - e.t < CFG.WINDOW_MS);
  arr.push(ev);
  if (arr.length > 60) arr = arr.slice(-60);
  events.set(low, arr);

  const pick = (list) => list.slice(-5).map(e => ({ t: e.t, ch: e.ch, to: e.to, text: e.raw }));
  const base = { isNew, accountAgeHours: created ? Math.round((now - created) / 3600000) : null };

  const similar = ev.norm.length >= CFG.MIN_NORM_LEN ? arr.filter(e => e.norm.length >= CFG.MIN_NORM_LEN && similarity(e, ev) >= CFG.SIMILARITY) : [];
  const dmTargets = new Set(similar.filter(e => e.to).map(e => e.to));
  const chans = new Set(similar.map(e => e.ch));
  const burst = arr.filter(e => now - e.t < CFG.FLOOD_WINDOW_MS);
  const links = arr.filter(e => e.link);
  const textA = analyzeText(raw);

  // «Балл подозрительности». По нему BotModerator решает, банить ли автоматически
  // (порог и защитные условия — в botmoderator.js). Администратор видит флаг в любом случае.
  let score = 0;
  score += Math.min(60, Math.max(0, similar.length - 2) * 10);   // одно и то же снова и снова
  score += Math.min(60, Math.max(0, chans.size - 1) * 20);       // …в разных местах
  score += Math.min(75, Math.max(0, dmTargets.size - 2) * 15);   // …разным людям в личку
  score += Math.min(45, links.length * 15);                      // ссылки
  score += textA.adPoints;                                       // рекламные слова
  if (burst.length >= (isNew ? CFG.FLOOD_NEW : CFG.FLOOD_OLD)) score += 15;

  const fire = (kind, info) => {
    notifySpam({ user, kind, score, isNew, info, channel: ev.ch });
    return raiseFlag(user, kind, info);
  };

  // 1. Рассылка одного и того же разным людям в личку
  if (dmTargets.size >= (isNew ? CFG.DM_RECIPIENTS_NEW : CFG.DM_RECIPIENTS_OLD))
    return fire('dm_spam', { ...base, count: similar.length, recipients: [...dmTargets].slice(0, 10), samples: pick(similar), score });

  // 2. Одно и то же в разных местах
  if (similar.length >= 3 && chans.size >= CFG.CROSS_CHANNELS)
    return fire('cross_post', { ...base, count: similar.length, channels: [...chans], samples: pick(similar), score });

  // 3. Однотипные сообщения
  if (similar.length >= (isNew ? CFG.REPEAT_NEW : CFG.REPEAT_OLD))
    return fire('repeat', { ...base, count: similar.length, channels: [...chans], samples: pick(similar), score });

  // 4. Флуд
  if (burst.length >= (isNew ? CFG.FLOOD_NEW : CFG.FLOOD_OLD))
    return fire('flood', { ...base, count: burst.length, channels: [...new Set(burst.map(e => e.ch))], samples: pick(burst), score });

  // 5. Ссылки
  if (links.length >= (isNew ? CFG.LINKS_NEW : CFG.LINKS_OLD))
    return fire('links', { ...base, count: links.length, channels: [...new Set(links.map(e => e.ch))], samples: pick(links), score });

  // 6. Рекламный текст даже в единственном сообщении (казино, ставки, «заработок» + ссылка…)
  if (textA.score >= 50)
    return fire('ad', { ...base, count: 1, channels: [ev.ch], reasons: textA.reasons, samples: pick([ev]), score });
}

// Вызывается из роутов/сокетов. Никогда не бросает и не блокирует запрос.
function record(o) {
  try { processEvent(o).catch(e => console.error('[Automod]', e.message)); } catch (e) { console.error('[Automod]', e.message); }
}

// Чистим память от давно молчащих
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of events) if (!arr.length || now - arr[arr.length - 1].t > CFG.WINDOW_MS) events.delete(k);
  for (const [k, ts] of skipUntil) if (ts < now) skipUntil.delete(k);
}, 5 * 60 * 1000).unref();


// ═══════════════════════════════════════════════════════════════
//  Админ-API автомодерации
// ═══════════════════════════════════════════════════════════════
// status флага: new | skipped | banned | shadowbanned
async function resolveFlags(low, status, adminName) {
  await db(`UPDATE automod_flags SET status=$1, resolved_by=$2, resolved_at=$3, updated_at=$3
            WHERE username_low=$4 AND status='new'`, [status, adminName, Date.now(), low]);
  clearOpenFlagKeys(low);
}

function parseDetails(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

app.get('/api/admin/automod/count', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    const r = await db(`SELECT COUNT(*) AS n FROM automod_flags WHERE status='new'`);
    res.json({ new: Number(r.rows[0].n) });
  });
});

app.get('/api/admin/automod/flags', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    try {
      const status = String(req.query.status || 'new');
      const where = status === 'new' ? `WHERE status='new'` : status === 'resolved' ? `WHERE status <> 'new'` : '';
      const r = await db(`SELECT * FROM automod_flags ${where} ORDER BY created_at DESC LIMIT 100`);
      const out = [];
      for (const row of r.rows) {
        const u = await getUser(row.username_low).catch(() => null);
        let warnCount = 0;
        try { const w = await db(`SELECT COUNT(*) AS n FROM user_warnings WHERE username_low=$1`, [row.username_low]); warnCount = Number(w.rows[0].n); } catch {}
        out.push({
          id: row.id, username: row.username, kind: row.kind, kindLabel: KIND_LABELS[row.kind] || row.kind,
          status: row.status, resolution: row.status !== 'new' ? row.status : null, resolvedBy: row.resolved_by || null,
          createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
          resolvedAt: row.resolved_at ? Number(row.resolved_at) : null,
          details: parseDetails(row.details),
          account: u ? {
            createdAt: u.createdAt, rating: u.rating, gamesPlayed: u.gamesPlayed,
            banned: !!u.banned, shadowBanned: !!u.shadowBanned, role: u.role || 'user', warnings: warnCount,
          } : null,
        });
      }
      res.json(out);
    } catch (e) { console.error('[Automod list]', e); res.status(500).json({ error: e.message }); }
  });
});

async function loadFlagOr404(req, res) {
  const r = await db(`SELECT * FROM automod_flags WHERE id=$1`, [req.params.id]);
  if (!r.rows.length) { res.status(404).json({ error: 'Флаг не найден' }); return null; }
  return r.rows[0];
}

// Пропустить: ложное срабатывание — не флагаем этого человека следующие 24 часа
app.post('/api/admin/automod/flags/:id/skip', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    try {
      const flag = await loadFlagOr404(req, res); if (!flag) return;
      await resolveFlags(flag.username_low, 'skipped', req.user.username);
      skipUntil.set(flag.username_low, Date.now() + CFG.SKIP_WHITELIST_MS);
      await logAdminAction(req.user.username, 'automod_skip', flag.username, { kind: flag.kind });
      res.json({ ok: true });
    } catch (e) { console.error('[Automod skip]', e); res.status(500).json({ error: e.message }); }
  });
});

// Бан (с мультиаккаунтами и каскадом)
app.post('/api/admin/automod/flags/:id/ban', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    try {
      const flag = await loadFlagOr404(req, res); if (!flag) return;
      const target = await getUser(flag.username_low);
      if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
      if (target.role === 'admin') return res.status(403).json({ error: 'Нельзя забанить администратора' });
      const reason = String(req.body.reason || '').trim().slice(0, 200) || ('Автомодерация: ' + (KIND_LABELS[flag.kind] || flag.kind));
      const out = await banUserFully(req.user.username, target, reason);
      await resolveFlags(flag.username_low, 'banned', req.user.username);
      res.json({ ok: true, accountsBanned: out.accountsBanned, cascade: out.cascade });
    } catch (e) { console.error('[Automod ban]', e); res.status(500).json({ error: e.message }); }
  });
});

// Теневой бан — человек ничего не замечает, но его сообщения/комментарии видит только он
app.post('/api/admin/automod/flags/:id/shadowban', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    try {
      const flag = await loadFlagOr404(req, res); if (!flag) return;
      const target = await getUser(flag.username_low);
      if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
      if (target.role === 'admin') return res.status(403).json({ error: 'Нельзя применить к администратору' });
      target.shadowBanned = true;
      target.shadowBanReason = String(req.body.reason || '').trim().slice(0, 200) || ('Автомодерация: ' + (KIND_LABELS[flag.kind] || flag.kind));
      await saveUser(target);
      invalidateModSets();
      await resolveFlags(flag.username_low, 'shadowbanned', req.user.username);
      await logAdminAction(req.user.username, 'shadowban', target.username, { reason: target.shadowBanReason, via: 'automod' });
      res.json({ ok: true });
    } catch (e) { console.error('[Automod shadowban]', e); res.status(500).json({ error: e.message }); }
  });
});


function skip(low, ms) { skipUntil.set(low, Date.now() + ms); }
function isSkipped(low) { const t = skipUntil.get(low); return !!t && t > Date.now(); }
function accountInfo(user) {
  let created = Number(user.createdAt) || 0;
  if (created && created < 1e11) created *= 1000;
  const ageMs = created ? Date.now() - created : null;
  return { created, ageMs, isNew: ageMs != null ? ageMs < CFG.NEW_ACCOUNT_MS : false };
}

module.exports = {
  record,
  analyzeText,
  onSpamEvent,
  raiseFlag,
  resolveFlags,
  ensureState: loadState,
  isSkipped,
  skip,
  accountInfo,
  normalize,
  getModSets,
  banUserFully,
  applyBanCascade,
  commentExclusions,
  filterVisible,
  isAuthorVisible,
  invalidateModSets,
  KIND_LABELS,
  CFG,
};