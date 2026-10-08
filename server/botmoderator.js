// ═══════════════════════════════════════════════════════════════
//  botmoderator.js — BotModerator: автоматический модератор
// ═══════════════════════════════════════════════════════════════
//  Аккаунт BotModerator (роль admin, войти в него нельзя — пароль случайный
//  и нигде не сохраняется). Работает по двум каналам:
//
//  1. Чат / личка / клубные и турнирные чаты / комментарии.
//     Детектор из moderation.js считает «балл подозрительности». Если он
//     ≥ BAN_SCORE и у аккаунта нет «иммунитета» (см. whyTrusted) — бот:
//       • банит в общем чате на 24 часа и стирает ВСЕ его сообщения,
//       • банит сам аккаунт (с каскадом: клубы, турниры, чаты),
//       • закрывает флаги в дашборде («Забанен · BotModerator»).
//
//  2. Контент: раз в минуту проверяет форум (темы и ответы), блоги,
//     клубы (название, описание), турниры (название, описание) и описания
//     профилей новых аккаунтов. Критичный спам → контент скрывается/удаляется,
//     автор банится. Всё подозрительное, но не критичное, — флагом в дашборд.
//
//  Защита от ложных банов (бот НЕ банит автоматически, если):
//   • аккаунту больше 3 суток, или сыграно больше 3 партий, или он VIP,
//   • это админ / владелец / автор новостей / админ блога,
//   • админ нажал «Пропустить» по этому человеку (24 часа иммунитета),
//   • бот уже забанил MAX_BANS_PER_HOUR человек за последний час
//     (защита от лавины при сбое — остальное уходит флагами),
//   • режим бота не «on».
//  Режимы (переключаются в админке, вкладка «Автомодерация»):
//   on  — баним сразу;  dry — только пишем в дашборд, что бот ЗАБАНИЛ БЫ;  off — выключен.
//  Всё, что сделал бот, пишется в журнал админ-действий под именем BotModerator,
//  а разбан делается обычной кнопкой «Разбанить».
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');
const {
  app, db, uuidv4, bcrypt,
  authMiddleware, requireAdmin,
  getUser, saveUser, rowToUser,
  io, emitToAdmins, logAdminAction, removeUserChatMessages, globalChat,
  forumThreads, forumReplies, saveForumThread, deleteForumThread, deleteForumReply,
  blogPosts, saveBlogPost,
  clubs, deleteClubFromDB,
  tournaments, deleteTournamentFromDB,
  isBlogAdmin, isNewsOwner, newsAuthors,
} = require('./core');
const moderation = require('./moderation');
const warnings = require('./warnings');

const BOT_NAME = 'BotModerator';
const BOT_LOW = BOT_NAME.toLowerCase();

const BOT = {
  BAN_SCORE:          100,                  // с этого балла — автобан
  SUSPECT_SCORE:      50,                   // с этого балла — флаг в дашборд (для контента)
  MAX_GAMES:          3,                    // «настоящие» игроки с партиями не банятся автоматически
  MAX_BANS_PER_HOUR:  5,                    // предохранитель
  CHAT_BAN_MINUTES:   24 * 60,              // бан в общем чате
  WARN_SCORE:         50,                   // с этого балла (и до BAN_SCORE) — предупреждение игроку
  WARN_COOLDOWN_MS:   6 * 3600 * 1000,      // одному человеку — не чаще раза в 6 часов
  MAX_WARNS_PER_HOUR: 20,                   // предохранитель
  CONTENT_LOOKBACK_MS: 24 * 3600 * 1000,    // контент старше суток бот не трогает
  SWEEP_MS:           60 * 1000,            // как часто проверяем контент
};

let mode = ['on', 'dry', 'off'].includes((process.env.BOT_MODERATOR_MODE || '').toLowerCase())
  ? process.env.BOT_MODERATOR_MODE.toLowerCase() : 'on';
let modeLoaded = false;
const banTimes = [];          // когда бот банил (для лимита в час)
const recent = [];            // последние действия бота (для админки)
const punishing = new Set();  // защита от параллельных наказаний одного человека
const warnTimes = [];         // когда бот предупреждал (лимит в час)
const lastWarn = new Map();   // usernameLow -> ts последнего предупреждения (кэш, чтобы не ходить в БД на каждое сообщение)


// ═══════════════════════════════════════════════════════════════
//  Настройки (режим переживает перезапуск)
// ═══════════════════════════════════════════════════════════════
db(`CREATE TABLE IF NOT EXISTS bot_moderator_state (key TEXT PRIMARY KEY, value TEXT)`).catch(() => {});

async function loadMode() {
  if (modeLoaded) return;
  try {
    const r = await db(`SELECT value FROM bot_moderator_state WHERE key='mode'`);
    if (r.rows.length && ['on', 'dry', 'off'].includes(r.rows[0].value)) mode = r.rows[0].value;
    modeLoaded = true;
  } catch { /* таблица ещё создаётся */ }
}
async function setMode(m) {
  mode = m;
  await db(`INSERT INTO bot_moderator_state (key, value) VALUES ('mode', $1)
            ON CONFLICT (key) DO UPDATE SET value = $1`, [m]);
}


// ═══════════════════════════════════════════════════════════════
//  Аккаунт BotModerator
// ═══════════════════════════════════════════════════════════════
let botReady = false;
async function ensureBotAccount() {
  if (botReady) return;
  try {
    const ex = await getUser(BOT_LOW);
    if (ex) { botReady = true; return; }
    const passwordHash = await bcrypt.hash(crypto.randomBytes(48).toString('hex'), 10); // пароль никто не знает
    await saveUser({
      id: uuidv4(), username: BOT_NAME, email: null, passwordHash,
      createdAt: Date.now(), createdFromIP: null, createdDeviceId: null,
      rating: 1200, gamesPlayed: 0, wins: 0, losses: 0, draws: 0,
      avatar: null, role: 'admin', banned: false,
    });
    botReady = true;
    console.log('[BotModerator] аккаунт создан');
  } catch (e) { /* БД/пользователи ещё не готовы — повторим на следующем тике */ }
}


// ═══════════════════════════════════════════════════════════════
//  Кого бот НЕ имеет права банить автоматически
// ═══════════════════════════════════════════════════════════════
function whyTrusted(user) {
  if (!user) return 'нет пользователя';
  const low = user.username.toLowerCase();
  if (low === BOT_LOW) return 'сам бот';
  if (user.banned) return 'уже забанен';
  if (user.role === 'admin') return 'администратор';
  if (low === 'chesshome' || isBlogAdmin(user.username) || isNewsOwner(user.username)
      || (newsAuthors || []).some(a => String(a).toLowerCase() === low)) return 'персонал сайта';
  if (user.vipUntil && Number(user.vipUntil) > Date.now()) return 'VIP';
  if (!moderation.accountInfo(user).isNew) return 'аккаунт не новый';
  if ((user.gamesPlayed || 0) > BOT.MAX_GAMES) return 'есть сыгранные партии';
  if (moderation.isSkipped(low)) return 'админ нажал «Пропустить»';
  return null;
}

// Персонал и бот: им предупреждения не шлём. Возраст аккаунта и партии для предупреждений значения не имеют:
// предупреждение безобидно, поэтому его получают и «старые» игроки.
function isStaff(user) {
  if (!user) return true;
  const low = user.username.toLowerCase();
  return low === BOT_LOW || user.role === 'admin' || low === 'chesshome'
    || isBlogAdmin(user.username) || isNewsOwner(user.username)
    || (newsAuthors || []).some(a => String(a).toLowerCase() === low);
}

function banBudgetLeft() {
  const hourAgo = Date.now() - 3600 * 1000;
  while (banTimes.length && banTimes[0] < hourAgo) banTimes.shift();
  return BOT.MAX_BANS_PER_HOUR - banTimes.length;
}

function remember(entry) {
  recent.unshift({ t: Date.now(), ...entry });
  if (recent.length > 20) recent.pop();
}


// ═══════════════════════════════════════════════════════════════
//  Наказание: бан в чате на 24 часа + стирание сообщений + бан аккаунта
// ═══════════════════════════════════════════════════════════════
async function chatBan24h(username, reason) {
  if (!global.chatBans) global.chatBans = new Map();
  global.chatBans.set(username.toLowerCase(), Date.now() + BOT.CHAT_BAN_MINUTES * 60 * 1000);
  await removeUserChatMessages(username).catch(e => console.error('[BotModerator] chat cleanup:', e.message));
  const sysMsg = `${username} заблокирован в чате на 24 часа. Соблюдайте правила платформы.`;
  globalChat.push({ id: crypto.randomUUID(), username: 'system', message: sysMsg, role: 'system', timestamp: Date.now(), system: true });
  if (globalChat.length > 500) globalChat.shift();
  io.emit('chat_system_msg', sysMsg);
  await logAdminAction(BOT_NAME, 'chat_ban', username, { durationMinutes: BOT.CHAT_BAN_MINUTES, reason, bot: true });
}

// Шаблон предупреждения по типу срабатывания
const WARN_TEMPLATE = {
  dm_spam: 'spam', cross_post: 'spam', ad: 'spam', repeat: 'flood', flood: 'flood', links: 'links',
  forum_thread: 'content', forum_reply: 'content', blog_post: 'content',
  club: 'bad_name', tournament: 'bad_name', bio: 'bad_name',
};

// Предупреждение «от имени системы». Не чаще раза в WARN_COOLDOWN_MS на человека.
// Возвращает { sent, why }.
async function maybeWarn(user, { kind, score, reason }) {
  const low = user.username.toLowerCase();
  try {
    await loadMode();
    if (mode === 'off') return { sent: false, why: 'бот выключен' };
    const fresh = await getUser(low);
    if (!fresh || fresh.banned || isStaff(fresh)) return { sent: false, why: 'не подходит' };
    if (moderation.isSkipped(low)) return { sent: false, why: 'админ нажал «Пропустить»' };

    const now = Date.now();
    let last = lastWarn.get(low);
    if (last == null) { last = await warnings.lastWarningAt(low); lastWarn.set(low, last); }
    if (now - last < BOT.WARN_COOLDOWN_MS) return { sent: false, why: 'недавно уже предупреждали' };

    const hourAgo = now - 3600 * 1000;
    while (warnTimes.length && warnTimes[0] < hourAgo) warnTimes.shift();
    if (warnTimes.length >= BOT.MAX_WARNS_PER_HOUR) return { sent: false, why: 'лимит предупреждений в час' };

    const template = WARN_TEMPLATE[kind] || 'spam';
    if (mode === 'dry') {
      lastWarn.set(low, now);                      // в режиме наблюдения не засоряем журнал повторами
      remember({ user: fresh.username, action: 'would_warn', score, reason });
      console.log(`[BotModerator] (dry) предупредил бы ${fresh.username}: ${reason}`);
      return { sent: false, why: 'режим наблюдения', wouldWarn: true };
    }
    lastWarn.set(low, now);                        // фиксируем ДО отправки — от гонок при частых событиях
    warnTimes.push(now);
    const out = await warnings.sendWarning({ username: fresh.username, template, by: BOT_NAME, source: 'bot', score });
    if (!out.ok) { lastWarn.set(low, last); return { sent: false, why: out.error }; }
    remember({ user: fresh.username, action: 'warn', score, reason });
    emitToAdmins('automod_bot_action', { username: fresh.username, action: 'warn', reason }).catch(() => {});
    console.log(`[BotModerator] предупредил ${fresh.username}: ${reason}`);
    return { sent: true };
  } catch (e) {
    console.error('[BotModerator] maybeWarn:', e.message);
    return { sent: false, why: 'ошибка: ' + e.message };
  }
}

// ev: { reason, score, source: 'chat' | 'content', detail }
async function punish(user, ev) {
  const low = user.username.toLowerCase();
  if (punishing.has(low)) return { done: false, why: 'уже наказывается' };
  punishing.add(low);
  try {
    const fresh = await getUser(low);          // свежие данные: за секунды могло что-то измениться
    const why = whyTrusted(fresh);
    if (why) return { done: false, why };
    if (mode === 'off') return { done: false, why: 'бот выключен' };

    const reason = `BotModerator: автоматический бан — ${ev.reason}`;
    if (mode === 'dry') {
      remember({ user: fresh.username, action: 'would_ban', score: ev.score, reason: ev.reason });
      console.log(`[BotModerator] (dry) забанил бы ${fresh.username}: ${ev.reason}`);
      return { done: false, why: 'режим наблюдения', wouldBan: true };
    }
    if (banBudgetLeft() <= 0) {
      remember({ user: fresh.username, action: 'limit', score: ev.score, reason: ev.reason });
      return { done: false, why: 'лимит банов в час исчерпан — решает человек' };
    }

    banTimes.push(Date.now());
    if (ev.source === 'chat') await chatBan24h(fresh.username, ev.reason);
    const out = await moderation.banUserFully(BOT_NAME, fresh, reason, {
      accountOnly: true, logExtra: { bot: true, score: ev.score, source: ev.source },
    });
    await moderation.resolveFlags(low, 'banned', BOT_NAME);
    remember({ user: fresh.username, action: 'ban', score: ev.score, reason: ev.reason });
    emitToAdmins('automod_bot_action', { username: fresh.username, action: 'ban', reason: ev.reason }).catch(() => {});
    console.log(`[BotModerator] забанил ${fresh.username}: ${ev.reason}`);
    return { done: true, out };
  } catch (e) {
    console.error('[BotModerator] punish:', e);
    return { done: false, why: 'ошибка: ' + e.message };
  } finally { punishing.delete(low); }
}

// Чат: детектор из moderation.js сообщает о каждом срабатывании
// Причины, при которых бан отклонён, но предупреждать тоже не нужно
const NO_WARN_WHY = new Set(['уже забанен', 'сам бот', 'администратор', 'персонал сайта', 'бот выключен', 'уже наказывается', 'нет пользователя']);

moderation.onSpamEvent(async (ev) => {
  if (ev.score < BOT.WARN_SCORE) return;
  await loadMode();
  const label = (moderation.KIND_LABELS[ev.kind] || ev.kind).toLowerCase();
  const reason = `${label} (балл ${ev.score})`;
  if (ev.score >= BOT.BAN_SCORE) {
    const p = await punish(ev.user, { source: 'chat', score: ev.score, reason });
    // Бан не поставлен (доверенный игрок, лимит и т.п.) — хотя бы предупреждаем
    if (!p.done && !NO_WARN_WHY.has(p.why) && p.why !== 'режим наблюдения') await maybeWarn(ev.user, { kind: ev.kind, score: ev.score, reason });
    return;
  }
  await maybeWarn(ev.user, { kind: ev.kind, score: ev.score, reason });   // 50–99: только предупреждение
});


// ═══════════════════════════════════════════════════════════════
//  Удаление контента (используют и бот, и кнопка «Удалить контент» в админке)
// ═══════════════════════════════════════════════════════════════
// force=true — решение человека: можно удалять и клуб с участниками, и турнир с игроками.
async function removeContent(type, id, { force = false } = {}) {
  try {
    if (type === 'forum_thread') {
      const i = forumThreads.findIndex(t => t.id === id); if (i < 0) return { removed: false, why: 'не найдено' };
      forumThreads.splice(i, 1);
      forumReplies.splice(0, forumReplies.length, ...forumReplies.filter(r => r.threadId !== id));
      await deleteForumThread(id);
      return { removed: true };
    }
    if (type === 'forum_reply') {
      const i = forumReplies.findIndex(r => r.id === id); if (i < 0) return { removed: false, why: 'не найдено' };
      const reply = forumReplies[i];
      const thread = forumThreads.find(t => t.id === reply.threadId);
      if (thread) { thread.replyCount = Math.max(0, (thread.replyCount || 1) - 1); await saveForumThread(thread); }
      forumReplies.splice(i, 1);
      await deleteForumReply(id);
      return { removed: true };
    }
    if (type === 'blog_post') {
      const post = blogPosts.find(p => p.id === id); if (!post) return { removed: false, why: 'не найдено' };
      post.status = 'hidden';                 // как у админского скрытия: статья пропадает, но не удаляется навсегда
      await saveBlogPost(post);
      return { removed: true };
    }
    if (type === 'club') {
      const i = clubs.findIndex(c => c.id === id); if (i < 0) return { removed: false, why: 'не найдено' };
      const c = clubs[i];
      if (c.official) return { removed: false, why: 'официальный клуб' };
      if (!force && (c.members || []).length > 1) return { removed: false, why: 'в клубе есть другие участники' };
      clubs.splice(i, 1);
      await deleteClubFromDB(id);
      return { removed: true };
    }
    if (type === 'tournament') {
      const i = tournaments.findIndex(t => t.id === id); if (i < 0) return { removed: false, why: 'не найдено' };
      const t = tournaments[i];
      const others = (t.participants || []).filter(p => !p.left && String(p.username).toLowerCase() !== String(t.createdBy).toLowerCase());
      if (!force && (others.length || (t.startsAt && t.startsAt <= Date.now()))) return { removed: false, why: 'в турнире есть игроки или он уже идёт' };
      tournaments.splice(i, 1);
      await deleteTournamentFromDB(id);
      io.emit('tournament_deleted', id);
      return { removed: true };
    }
    if (type === 'bio') {
      const u = await getUser(String(id).toLowerCase()); if (!u) return { removed: false, why: 'не найдено' };
      u.bio = ''; await saveUser(u);
      return { removed: true };
    }
    return { removed: false, why: 'неизвестный тип' };
  } catch (e) {
    console.error('[BotModerator] removeContent:', e);
    return { removed: false, why: e.message };
  }
}


// ═══════════════════════════════════════════════════════════════
//  Проверка контента: форум, блоги, клубы, турниры, описания профилей
// ═══════════════════════════════════════════════════════════════
const TYPE_LABEL = {
  forum_thread: 'тема форума', forum_reply: 'ответ на форуме', blog_post: 'статья блога',
  club: 'клуб', tournament: 'турнир', bio: 'описание профиля',
};
const seen = new Map();   // `${type}:${id}` -> сигнатура (длина текста): не проверяем одно и то же дважды

async function collectItems() {
  const since = Date.now() - BOT.CONTENT_LOOKBACK_MS;
  const items = [];
  const add = (type, id, author, title, text, createdAt) => {
    if (!author || !(createdAt >= since)) return;
    items.push({ type, id, author: String(author), title: String(title || '').slice(0, 80), text: String(text || ''), createdAt });
  };
  for (const t of forumThreads) add('forum_thread', t.id, t.author, t.title, `${t.title}\n${t.body}`, t.createdAt);
  for (const r of forumReplies) add('forum_reply', r.id, r.author, '', r.body, r.createdAt);
  for (const p of blogPosts) if (p.status === 'published') add('blog_post', p.id, p.author, p.title, `${p.title}\n${p.body}`, p.createdAt);
  for (const c of clubs) add('club', c.id, c.createdBy, c.name, `${c.name}\n${c.description || ''}`, Date.parse(c.createdAt) || 0);
  for (const t of tournaments) add('tournament', t.id, t.createdBy, t.name, `${t.name}\n${t.description || ''}`, Number(t.createdAt) || 0);
  try {   // описания профилей — только у новых аккаунтов
    const r = await db(`SELECT * FROM users WHERE created_at > $1 AND bio IS NOT NULL AND bio <> ''`, [since]);
    for (const row of r.rows) { const u = rowToUser(row); add('bio', u.username, u.username, '', u.bio, Number(u.createdAt) || 0); }
  } catch { /* колонки/таблица недоступны — просто пропускаем описания */ }
  return items;
}

async function sweepContent() {
  await loadMode();
  if (mode === 'off') return;
  if (!(await moderation.ensureState())) return;   // открытые флаги и «Пропустить» должны быть загружены

  const items = await collectItems();
  if (!items.length) return;

  // Один и тот же текст у одного автора в нескольких местах — признак рассылки
  const dupCount = new Map();
  for (const it of items) {
    const n = moderation.normalize(it.text);
    it.norm = n;
    if (n.length >= 8) { const k = it.author.toLowerCase() + '|' + n; dupCount.set(k, (dupCount.get(k) || 0) + 1); }
  }

  const byAuthor = new Map();   // для уборки всего контента забаненного автора
  for (const it of items) { const k = it.author.toLowerCase(); (byAuthor.get(k) || byAuthor.set(k, []).get(k)).push(it); }

  for (const it of items) {
    const key = `${it.type}:${it.id}`;
    if (seen.get(key) === it.text.length) continue;
    seen.set(key, it.text.length);

    const a = moderation.analyzeText(it.text);
    let score = a.score;
    const reasons = [...a.reasons];
    if ((dupCount.get(it.author.toLowerCase() + '|' + it.norm) || 0) >= 2) { score += 40; reasons.push('одинаковый текст в нескольких местах'); }
    if (score < BOT.SUSPECT_SCORE) continue;

    const user = await getUser(it.author.toLowerCase());
    if (!user || user.banned || user.role === 'admin') continue;
    if (moderation.isSkipped(user.username.toLowerCase())) continue;

    const info = {
      ...(() => { const ai = moderation.accountInfo(user); return { isNew: ai.isNew, accountAgeHours: ai.ageMs != null ? Math.round(ai.ageMs / 3600000) : null }; })(),
      count: 1, channels: [it.type], reasons, score,
      samples: [{ t: it.createdAt, ch: it.type, text: (it.title ? it.title + ' — ' : '') + it.text.replace(/\s+/g, ' ').slice(0, 160) }],
      content: { type: it.type, id: it.id, label: TYPE_LABEL[it.type] },
    };

    const trusted = whyTrusted(user);
    if (score >= BOT.BAN_SCORE && !trusted && mode === 'on' && banBudgetLeft() > 0) {
      const res = await removeContent(it.type, it.id);
      const p = await punish(user, { source: 'content', score, reason: `спам: ${TYPE_LABEL[it.type]} (${reasons.join(', ')})` });
      if (p.done) {
        // Автор забанен — убираем и остальной его контент за сутки
        for (const other of byAuthor.get(user.username.toLowerCase()) || []) {
          if (other !== it) await removeContent(other.type, other.id);
        }
        continue;
      }
      if (res.removed) info.botNote = 'бот скрыл контент, но автора не забанил: ' + (p.why || '');
    } else if (score >= BOT.BAN_SCORE && !trusted && mode === 'dry') {
      info.botNote = 'режим наблюдения: бот забанил бы автора и удалил контент';
      remember({ user: user.username, action: 'would_ban', score, reason: `${TYPE_LABEL[it.type]}: ${reasons.join(', ')}` });
    }
    // Не критично (50–99) или бан не состоялся — предупреждаем автора, контент остаётся
    const w = await maybeWarn(user, { kind: it.type, score, reason: `${TYPE_LABEL[it.type]}: ${reasons.join(', ')} (балл ${score})` });
    if (w.sent) info.botNote = (info.botNote ? info.botNote + '; ' : '') + 'бот отправил предупреждение автору';
    else if (w.wouldWarn) info.botNote = (info.botNote ? info.botNote + '; ' : '') + 'режим наблюдения: бот предупредил бы автора';
    await moderation.raiseFlag(user, 'content', info);
  }

  // Память: забываем то, что вышло за окно проверки
  if (seen.size > 5000) seen.clear();
}


// ═══════════════════════════════════════════════════════════════
//  Админ-API
// ═══════════════════════════════════════════════════════════════
app.get('/api/admin/botmoderator', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    await loadMode();
    res.json({
      name: BOT_NAME, mode, banScore: BOT.BAN_SCORE, warnScore: BOT.WARN_SCORE, maxBansPerHour: BOT.MAX_BANS_PER_HOUR,
      bansLastHour: BOT.MAX_BANS_PER_HOUR - banBudgetLeft(), recent,
    });
  });
});

app.post('/api/admin/botmoderator', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    const m = String(req.body.mode || '');
    if (!['on', 'dry', 'off'].includes(m)) return res.status(400).json({ error: 'Режим: on, dry или off' });
    await setMode(m);
    await logAdminAction(req.user.username, 'botmoderator_mode', BOT_NAME, { mode: m });
    res.json({ ok: true, mode: m });
  });
});

// Отмена бана, который поставил бот: снимает бан и бан в чате, а бот 24 часа не трогает этого человека.
// (Из клубов и турниров человек при бане вышел — это не возвращается, зайдёт сам.)
app.post('/api/admin/botmoderator/undo', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    try {
      const target = await getUser(String(req.body.username || '').toLowerCase());
      if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
      target.banned = false; target.banReason = null;
      await saveUser(target);
      if (global.chatBans) global.chatBans.delete(target.username.toLowerCase());
      moderation.skip(target.username.toLowerCase(), 24 * 3600 * 1000);
      moderation.invalidateModSets();
      await logAdminAction(req.user.username, 'unban', target.username, { via: 'botmoderator_undo' });
      remember({ user: target.username, action: 'undone', reason: 'отменено: ' + req.user.username });
      res.json({ ok: true });
    } catch (e) { console.error('[BotModerator undo]', e); res.status(500).json({ error: e.message }); }
  });
});

// Кнопка «Удалить контент» у флага (решение человека — без ограничений бота)
app.post('/api/admin/automod/flags/:id/remove-content', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    try {
      const r = await db(`SELECT * FROM automod_flags WHERE id=$1`, [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Флаг не найден' });
      let details = {}; try { details = JSON.parse(r.rows[0].details || '{}'); } catch {}
      if (!details.content) return res.status(400).json({ error: 'У этого флага нет контента' });
      const out = await removeContent(details.content.type, details.content.id, { force: true });
      if (!out.removed) return res.status(409).json({ error: 'Не удалось удалить: ' + (out.why || '') });
      await moderation.resolveFlags(r.rows[0].username_low, 'resolved', req.user.username);
      await logAdminAction(req.user.username, 'automod_remove_content', r.rows[0].username, details.content);
      res.json({ ok: true });
    } catch (e) { console.error('[Automod remove-content]', e); res.status(500).json({ error: e.message }); }
  });
});


// ═══════════════════════════════════════════════════════════════
//  Запуск
// ═══════════════════════════════════════════════════════════════
setInterval(() => { ensureBotAccount().catch(() => {}); }, 30 * 1000).unref();
setInterval(() => { sweepContent().catch(e => console.error('[BotModerator] sweep:', e.message)); }, BOT.SWEEP_MS).unref();

// Мёртвые экспорты УДАЛЕНЫ (sweepContent, whyTrusted, ensureBotAccount,
// _recent): внешние модули их не импортируют — функции вызываются
// таймерами и колбэками внутри самого файла.
module.exports = {
  BOT_NAME, BOT, punish, removeContent,
  getMode: () => mode,
};