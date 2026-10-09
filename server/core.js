// ═══════════════════════════════════════════════════════════════
//  core.js — общее состояние сервера
// ═══════════════════════════════════════════════════════════════
// Системные синглтоны (app, io, server, env), общие кэши и хелперы.
// Доменная логика вынесена в сервисные модули:
//   server/db.js                          — пул PostgreSQL, db(), транзакции
//   server/services/game.service.js       — партии, часы, финалы, рейтинг
//   server/services/tournament.service.js — турниры, жеребьёвка, тик
//   server/services/chat.service.js       — история чатов (глобал/клубы/турниры)
//   server/utils.js                       — серверные хелперы (escapeHtml)
//
// routes.js и sockets.js делают:
//   const { app, io, db, ... } = require('./core');
// и используют эти же самые объекты — состояние по-настоящему общее,
// это НЕ копии. Экспорт внизу файла дополняет module.exports
// через Object.assign — ссылки у всех общие.
// ═══════════════════════════════════════════════════════════════

const express = require('express');

const http    = require('http');

// crypto — для constant-time сравнения секретов (durka/worker ключи),
// чтобы исключить timing-атаки на строковое сравнение (см. durkaKeyMiddleware
// ниже и worker_auth в sockets.js).
const crypto  = require('crypto');

const { Server } = require('socket.io');

// npm install compression — жмёт HTTP-ответы (JSON/HTML/JS/CSS) gzip'ом.
// На 1 ядре это дешёвая по CPU операция (сжатие лёгкое, express.json уже
// режет тела до 50kb), а трафика и времени ответа на медленных сетях
// экономит заметно, особенно под 100 одновременных клиентов.
const compression = require('compression');

const bcrypt  = require('bcryptjs');

const jwt     = require('jsonwebtoken');

const { v4: uuidv4 } = require('uuid');

const path    = require('path');

const fs      = require('fs');

const cors    = require('cors');

// npm install multer — обработка multipart/form-data для загрузки обложек новостей.
const multer  = require('multer');

// ── PostgreSQL: пул и хелперы запросов — в server/db.js ────────
const { pool, db, withTransaction } = require('./db');

// ── Сервисные модули (см. шапку файла) ────────────────────────
const chatService       = require('./services/chat.service');
const gameService       = require('./services/game.service');
const tournamentService = require('./services/tournament.service');

const {
  globalChat,
  loadChat,
  saveChatMsg,
  deleteChatMsg,
  CLUB_CHAT_MAX,
  clubChats,
  clubChatBans,
  getClubChat,
  getClubChatBans,
  loadClubChats,
  saveClubChatMsg,
  deleteClubChatMsgsByUser,
  TOURNAMENT_CHAT_MAX,
  TOURNAMENT_CHAT_READONLY_AFTER_MS,
  tournamentChats,
  tournamentChatMutes,
  getTournamentChat,
  getTournamentChatMutes,
  isTournamentChatOpen,
  loadTournamentChats,
  saveTournamentChatMsg,
  wipeTournamentChatMsgsByUser,
  removeUserChatMessages,
} = chatService;

const {
  activeGames,
  tournamentGames,
  liveClock,
  hasFullMove,
  endGameAuthoritative,
  recordGame,
  updateStats,
  startGame,
  serverChess,
} = gameService;

const {
  tournaments,
  loadTournaments,
  saveTournament,
  deleteTournamentFromDB,
  MAX_INTERCLUB_TEAMS,
  extractClubIdFromLink,
  resolveInterclubTeams,
  getTournamentStatus,
  getInterclubTeamsInfo,
  computeTeamStandings,
  sanitizeTournament,
  REMATCH_GRACE_PERIOD,
  tryPairTournamentPlayers,
  FIRST_MOVE_TIMEOUT,
  startTournamentGame,
  finishTournamentGame,
  anticheatBan,
} = tournamentService;

require('dotenv').config();


// ── Фильтр матерных ников ─────────────────────────────────────
const BAD_NICK_WORDS = [
  'хуй','хуе','хер','пизд','бляд','блять','ебал','ебан','еблан',
  'fuck','bitch','dick','shit','ass','cunt','nigger','nigga',
  'сука','мразь','шлюх','гандон','мудак','урод','дебил',
];

function normNick(s) {
  return s.toLowerCase()
    .replace(/[0]/g,'o').replace(/[1!]/g,'i').replace(/[3]/g,'e')
    .replace(/[4]/g,'a').replace(/[@]/g,'a').replace(/[5]/g,'s')
    .replace(/[_\-\.]/g,'');
}

function nickHasBadWord(username) {
  const n = normNick(username);
  return BAD_NICK_WORDS.some(w => n.includes(normNick(w)));
}

// ── Белый список эмодзи профиля ───────────────────────────────
// ВАЖНО: это единственная надёжная защита от подмены эмодзи
const PROFILE_EMOJIS = new Set([
  '😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰',
  '😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🤩','🥳','😏',
  '😒','😞','😔','😟','😕','🙁','☹️','😣','😖','😫','😩','🥺','😢','😭','😤','😠',
  '😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🤭','🤫','🤥',
  '😶','😐','😑','😬','🙄','😯','😦','😧','😮','😲','🥱','😴','🤤','😪','😵','🤐',
  '🥴','🤢','🤮','🤧','😷','🤒','🤕','🤑','🤠','😈','👿','👹','👺','💩','👻','💀',
  '☠️','👽','🤖','🎃','😺','😸','😹','😻','😼','😽','🙀','😿','😾','🙈','🙉','🙊',
  '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐒','🐔',
  '🐧','🐦','🐤','🐣','🐥','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🦟',
  '🦗','🕷️','🦂','🐢','🐍','🦎','🐙','🦑','🦐','🦞','🐠','🐟','🐡','🐬','🐳','🐋',
  '🦈','🐊','🐅','🐆','🦓','🦍','🦧','🦣','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🐃',
  '🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🐈','🐓','🦃','🐇','🐁',
  '🐀','🐿️','🦔','🐾','🐉','🐲','🌵','🎄','🌲','🌳','🌴','🌿','🍀','🍁','🍂','🍃',
  '🍇','🍈','🍉','🍊','🍋','🍌','🍍','🥭','🍎','🍏','🍐','🍑','🍒','🍓','🥝','🍅',
  '🥥','🥑','🍆','🥔','🥕','🌽','🌶️','🥒','🥬','🥦','🧄','🧅','🍄','🥜','🌰','🍞',
  '🥐','🥖','🥨','🥯','🥞','🧇','🧀','🍖','🍗','🥩','🥓','🍔','🍟','🍕','🌭','🥪',
  '🌮','🌯','🥙','🧆','🥚','🍳','🥘','🍲','🥣','🥗','🍿','🧈','🧂','🥫','🍱','🍘',
  '🍙','🍚','🍛','🍜','🍝','🍠','🍢','🍣','🍤','🍥','🥮','🍡','🥟','🥠','🥡','🦀',
  '🍦','🍧','🍨','🍩','🍪','🎂','🍰','🧁','🥧','🍫','🍬','🍭','🍮','🍯','🥛','🍼',
  '🥤','🧃','🧉','🧊','🍺','🍻','🥂','🥃','🥄','🍴','🍽️','🥢',
  '⚽','🏀','🏈','⚾','🥎','🏐','🏉','🎾','🥏','🎳','🏆','🥇','🥈','🥉',
  '🎮','🕹️','🎲','🎭','🎨','🎬','🎤','🎧','🎼','🎹','🥁','🎸','🎷','🎺','🎻',
  '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','💕','💞','💓','💗','💖','💘','💝',
  '✨','🌟','⭐','🌙','☀️','🌈','⚡','💫','☄️','❄️','☃️','⛄','🔥','💧','🌊','🌪️',
  '🎁','🎀','🎊','🎉','🎈','🎃','🎄','🎋','🎆','🎇'
]);


// ── Защита от похожих ников ───────────────────────────────────
function normForSimilarity(name) {
  return name.toLowerCase()
    .replace(/[іі]/g,'i').replace(/[аА]/g,'a').replace(/[еЕ]/g,'e')
    .replace(/[оО]/g,'o').replace(/[рР]/g,'p').replace(/[сС]/g,'c')
    .replace(/[хХ]/g,'x').replace(/[вВ]/g,'b').replace(/[_\-\.]/g,'')
    .replace(/0/g,'o').replace(/1/g,'i').replace(/3/g,'e');
}


const app = express();


// ── Cookie-парсер (без внешней зависимости) ───────────────────
// Разбирает заголовок Cookie в req.cookies, используется вместо
// хранения JWT/device-id в localStorage (защита от чтения через XSS).
function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (!k) return;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  });
  return out;
}

app.use((req, res, next) => { req.cookies = parseCookieHeader(req.headers.cookie); next(); });


const isProd = process.env.NODE_ENV === 'production';

const AUTH_COOKIE_OPTS = { httpOnly: true, secure: isProd, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' };

const DEVICE_COOKIE_OPTS = { httpOnly: true, secure: isProd, sameSite: 'lax', maxAge: 5 * 365 * 24 * 60 * 60 * 1000, path: '/' };


// ── Device ID выдаётся и хранится ТОЛЬКО сервером (HttpOnly) ──
app.use((req, res, next) => {
  let deviceId = req.cookies.ch_device_id;
  if (!deviceId) {
    deviceId = 'dev_' + uuidv4();
    res.cookie('ch_device_id', deviceId, DEVICE_COOKIE_OPTS);
  }
  req.deviceId = deviceId;
  next();
});


// ── Получение JWT: приоритет — HttpOnly cookie, затем заголовок ──
// (заголовок оставлен как резерв для не-браузерных клиентов;
// само веб-приложение больше не хранит и не отправляет токен через JS)
function getAuthToken(req) {
  if (req.cookies && req.cookies.ch_token) return req.cookies.ch_token;
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  return null;
}


// ── Доверие к прокси (Nginx + Cloudflare) ────────────────────
// ВАЖНО: должно быть ДО любых middleware и роутов.
// Значение 2 означает: доверяем двум уровням прокси —
//   1-й hop: Cloudflare → ваш сервер
//   2-й hop: Nginx → Node.js
// После этого req.ip будет автоматически содержать реальный IP клиента.
app.set('trust proxy', 2);


// ── DDoS / Rate limiting ──────────────────────────────────────
class RateLimiter {
  constructor(windowMs, max) {
    this.windowMs = windowMs; this.max = max; this.store = new Map();
    this.maxEntries = 200_000;
    setInterval(() => {
      const now = Date.now();
      for (const [ip, data] of this.store.entries()) {
        if (now > data.resetAt) this.store.delete(ip);
      }
    }, 60000).unref();
  }
  check(ip) {
    const now = Date.now();
    let data = this.store.get(ip);
    if (!data || now > data.resetAt) {
      // Вытеснение при переполнении — ДО вставки новой записи.
      if (!data && this.store.size >= this.maxEntries) {
        const oldest = this.store.keys().next().value;
        if (oldest !== undefined) this.store.delete(oldest);
      }
      data = { count: 0, resetAt: now + this.windowMs };
      this.store.set(ip, data);
    }
    data.count++;
    return { allowed: data.count <= this.max, count: data.count, max: this.max };
  }
}


const limiterGeneral   = new RateLimiter(60_000,  10000);

const limiterAuth      = new RateLimiter(60_000,    20);

const limiterStrict    = new RateLimiter(60_000,    900);

const socketLimiter    = new RateLimiter(10_000,   1000);

const limiterRegStrict = new RateLimiter(3_600_000, 1000);


// ── PUZZLE STORM: серверный трекинг забегов ─────────────────────
const STORM_DURATION_MS   = 180_000;
        // должно совпадать со STORM_DURATION в storm.html
const STORM_MAX_TIME_MS   = STORM_DURATION_MS * 1.5 + 20_000;
 // +50% от бонусов стрика, +20с запас на сеть/рендер
const STORM_MIN_MS_PER_PUZZLE = 350;
        // быстрее физически не решить и не увидеть следующую задачу
const stormRuns = new Map();
 // runId -> { userId, startedAt }
setInterval(() => {
  const cutoff = Date.now() - STORM_MAX_TIME_MS - 60_000;
  for (const [id, run] of stormRuns) if (run.startedAt < cutoff) stormRuns.delete(id);
}, 5 * 60_000);


// ── IP-БАН ────────────────────────────────────────────────────
const bannedIPs     = new Set();

const bannedDevices = new Set();


async function loadBansFromDB() {
  try {
    const ips  = await db('SELECT ip FROM ip_bans');
    const devs = await db('SELECT device_id FROM device_bans');
    for (const r of ips.rows)  if (!isLocalIP(r.ip)) bannedIPs.add(r.ip);
    for (const r of devs.rows) bannedDevices.add(r.device_id);
    console.log(`[Bans] Загружено: ${bannedIPs.size} IP, ${bannedDevices.size} устройств`);
  } catch (e) {
    console.error('[Bans] load error:', e.message);
    if (/relation .* does not exist/i.test(e.message || '')) {
      console.error('[Bans] КРИТИЧНО: таблицы ip_bans/device_bans не существуют. ' +
        'Примените базовую схему: node migrations/migrate.js (см. migrations/001_base_schema.sql). ' +
        'Сервер продолжит работу с ПУСТЫМ списком банов!');
    }
  }
}


async function saveBanToDB(ip, deviceId) {
  try {
    if (ip && !isLocalIP(ip))  await db('INSERT INTO ip_bans (ip) VALUES ($1) ON CONFLICT DO NOTHING', [ip]);
    if (deviceId)              await db('INSERT INTO device_bans (device_id) VALUES ($1) ON CONFLICT DO NOTHING', [deviceId]);
  } catch (e) {}
}

async function removeBanFromDB(ip, deviceId) {
  try {
    if (ip)       await db('DELETE FROM ip_bans WHERE ip = $1', [ip]);
    if (deviceId) await db('DELETE FROM device_bans WHERE device_id = $1', [deviceId]);
  } catch (e) {}
}


// ── Кэш пользователей ─────────────────────────────────────────
const usersCache = new Map();

const USERS_CACHE_MAX = 100_000;

function cacheUser(u) {
  if (!u) return;
  const key = u.username_low || u.username.toLowerCase();
  // Перезапись существующего ключа не растит Map — обновим позицию вставки,
  // чтобы «горячие» пользователи не вытеснялись первыми.
  if (usersCache.has(key)) usersCache.delete(key);
  else if (usersCache.size >= USERS_CACHE_MAX) {
    const oldest = usersCache.keys().next().value;
    if (oldest !== undefined) usersCache.delete(oldest);
  }
  usersCache.set(key, u);
}


function rowToUser(row) {
  if (!row) return null;
  return {
    id:               row.id,
    username:         row.username,
    email:            row.email,
    passwordHash:     row.password_hash,
    rating:           row.rating,
    gamesPlayed:      row.games_played,
    wins:             row.wins,
    losses:           row.losses,
    draws:            row.draws,
    avatar:           row.avatar,
    role:             row.role,
    banned:           row.banned,
    banReason:        row.ban_reason,
    shadowBanned:     row.shadow_banned || false,
    shadowBanReason:  row.shadow_ban_reason || null,
    createdAt:        Number(row.created_at),
    createdFromIP:    row.created_from_ip,
    createdDeviceId:  row.created_device_id,
    puzzle_rating:    row.puzzle_rating,
    puzzle_solved:    row.puzzle_solved,
    puzzle_attempted: row.puzzle_attempted,
    storm_best:       row.storm_best   || 0,
    storm_runs:       row.storm_runs   || 0,
    emoji:            row.emoji        || '',
    bio:              row.bio         || '',
    fshrRating:       row.fshr_rating != null ? row.fshr_rating : null,
    fideRating:       row.fide_rating != null ? row.fide_rating : null,
    vipUntil:         row.vip_until != null ? Number(row.vip_until) : null,
    badges:           Array.isArray(row.badges) ? row.badges : [],
  };
}


// ── VIP-значок ───────────────────────────────────────────────
// Значок временный: активен, пока vipUntil в будущем. Никакой
// отдельной чистки не требуется — как только время истекло,
// isVip() везде начинает возвращать false сам по себе.
function isVip(u) { return !!(u && u.vipUntil && u.vipUntil > Date.now()); }

// Выдавать/снимать VIP-значок могут сайт-админы (роль 'admin' в БД или
// legacy-ники bootstrap — см. isSiteAdmin).
function isVipGranter(username) { return isSiteAdmin(username); }


// ── Значки в профиле (сезоны и т.п.) ─────────────────────────
// В БД у игрока хранится только массив id значков (users.badges), а
// картинки/названия живут здесь. Чтобы добавить новый значок — положите
// картинку в public/img/seasons/ и допишите строку в каталог ниже.
// Удалённый из каталога значок просто перестанет показываться (id в БД
// останется и вернётся, если строку вернуть).
const USER_BADGES = {
  winner: { title: 'Победитель сезона', img: '/img/seasons/winner.png' },
  // winner_s3: { title: 'Победитель 3 сезона', img: '/img/seasons/winner_s3.png' },
};

function getUserBadges(u) {
  return ((u && u.badges) || [])
    .filter(id => USER_BADGES[id])
    .map(id => ({ id, title: USER_BADGES[id].title, img: USER_BADGES[id].img }));
}


async function getUser(usernameLow) {
  if (usersCache.has(usernameLow)) return usersCache.get(usernameLow);
  const r = await db('SELECT * FROM users WHERE username_low = $1', [usernameLow]);
  const u = rowToUser(r.rows[0]);
  if (u) cacheUser(u);
  return u;
}


async function saveUser(u) {
  await db(`
    INSERT INTO users (id, username, username_low, email, password_hash, rating,
      games_played, wins, losses, draws, avatar, role, banned, ban_reason,
      created_at, created_from_ip, created_device_id, emoji, bio, fshr_rating, fide_rating,
      vip_until, shadow_banned, shadow_ban_reason, badges)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
    ON CONFLICT (id) DO UPDATE SET
      rating=$6, games_played=$7, wins=$8, losses=$9, draws=$10,
      avatar=$11, role=$12, banned=$13, ban_reason=$14, emoji=$18,
      bio=$19, fshr_rating=$20, fide_rating=$21, vip_until=$22,
      shadow_banned=$23, shadow_ban_reason=$24, badges=$25
  `, [u.id, u.username, u.username.toLowerCase(), u.email || null,
      u.passwordHash, u.rating, u.gamesPlayed, u.wins, u.losses, u.draws,
      u.avatar || null, u.role || 'user', u.banned || false, u.banReason || null,
      u.createdAt, u.createdFromIP || null, u.createdDeviceId || null, u.emoji || '',
      u.bio || '', u.fshrRating ?? null, u.fideRating ?? null,
      u.vipUntil ?? null, u.shadowBanned || false, u.shadowBanReason || null,
      JSON.stringify(u.badges || [])]);
}


// ── Кэш глобального чата, турниры и их чаты — в services/ ─────
// chat.service.js: globalChat/loadChat/saveChatMsg/deleteChatMsg,
//                  клубные и турнирные чаты (кэши + БД)
// tournament.service.js: tournaments/loadTournaments/saveTournament
// game.service.js: activeGames, часы, финалы партий


// ── Клубы ─────────────────────────────────────────────────────
const clubs = [];

async function loadClubs() {
  const r = await db('SELECT * FROM clubs ORDER BY member_count DESC');
  for (const row of r.rows) {
    clubs.push({
      id: row.id, name: row.name, description: row.description,
      createdAt: row.created_at, createdBy: row.created_by,
      admins: row.admins, members: row.members,
      memberCount: row.member_count, official: row.official,
    });
  }
}

async function saveClub(c) {
  await db(`
    INSERT INTO clubs (id, name, description, created_at, created_by, admins, members, member_count, official)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (id) DO UPDATE SET
      name=$2, description=$3, admins=$6, members=$7, member_count=$8
  `, [c.id, c.name, c.description || null, c.createdAt, c.createdBy,
      JSON.stringify(c.admins || []), JSON.stringify(c.members || []),
      c.memberCount || 0, c.official || false]);
}

async function deleteClubFromDB(id) {
  await db('DELETE FROM clubs WHERE id = $1', [id]);
}


// ── Чаты клубов: права и модерация ────────────────────────────

// Сайт-админ: источник истины — роль 'admin' в БД (users.role). Она:
//  1) подтверждается на старте для legacy-ников bootstrap (см. main()),
function isSiteAdmin(username) {
  if (!username) return false;
  const low = String(username).toLowerCase();
  const u = usersCache.get(low);
  if (u) return u.role === 'admin';
  return ['chesshome', 'marina64'].includes(low);
}

function isClubModerator(club, username) {
  if (!username) return false;
  if (isSiteAdmin(username)) return true;
  const lname = username.toLowerCase();
  // Создатель клуба всегда сохраняет права модератора, даже если технически
  // выпал из club.admins (например, вышел из клуба и зашёл снова).
  if ((club.createdBy || '').toLowerCase() === lname) return true;
  return (club.admins || []).map(a => a.toLowerCase()).includes(lname);
}

// Может ли пользователь управлять турниром: сайт-админ ИЛИ администратор клуба,
// к которому привязан этот турнир (создатель клуба всегда входит в club.admins).
function canManageTournament(user, t) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  // Межклубные турниры (t.isInterclub) не привязаны к одному клубу (t.clubId === null),
  // поэтому этот блок для них не срабатывает — управлять ими может ТОЛЬКО сайт-админ.
  if (t.clubId) {
    const club = clubs.find(c => c.id === t.clubId);
    if (club && isClubModerator(club, user.username)) return true;
  }
  return false;
}


// Аналог requireAdmin, но также пускает администраторов клуба для турниров их клуба.
async function requireTournamentManager(req, res, cb) {
  try {
    const me = await getUser(req.user.username.toLowerCase());
    if (!me) return res.status(403).json({ error: 'Нет прав' });
    const t = tournaments.find(t => t.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'Не найден' });
    if (!canManageTournament(me, t)) return res.status(403).json({ error: 'Нет прав' });
    await cb(t, me);
  } catch (e) {
    console.error('[requireTournamentManager]', e);
    if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}

function canWriteInClubChat(club, username) {
  if (!username) return false;
  if (isSiteAdmin(username)) return true;
  return (club.members || []).map(m => m.toLowerCase()).includes(username.toLowerCase());
}


// ── Чат турниров: права модерации ────────────────────────────
// Модератор чата турнира: сайт-админ, админ клуба (если турнир клубный)
// ИЛИ создатель конкретно этого турнира. Само хранилище чатов —
// в services/chat.service.js.
function canModerateTournamentChat(user, t) {
  if (!user) return false;
  if (canManageTournament(user, t)) return true;
  return !!(t.createdBy && user.username.toLowerCase() === t.createdBy.toLowerCase());
}


// ── Форум ─────────────────────────────────────────────────────
const forumThreads = [];

const forumReplies = [];

async function loadForum() {
  const thr = await db('SELECT * FROM forum_threads ORDER BY last_activity_at DESC');
  for (const row of thr.rows) {
    forumThreads.push({
      id: row.id, slug: row.slug, author: row.author, authorId: row.author_id,
      title: row.title, body: row.body,
      createdAt: Number(row.created_at), lastActivityAt: Number(row.last_activity_at),
      replyCount: row.reply_count, views: row.views,
    });
  }
  const rep = await db('SELECT * FROM forum_replies ORDER BY created_at ASC');
  for (const row of rep.rows) {
    forumReplies.push({
      id: row.id, threadId: row.thread_id, author: row.author, authorId: row.author_id,
      body: row.body, createdAt: Number(row.created_at),
    });
  }
}

async function saveForumThread(t) {
  await db(`
    INSERT INTO forum_threads (id, slug, author, author_id, title, body, created_at, last_activity_at, reply_count, views)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (id) DO UPDATE SET
      last_activity_at=$8, reply_count=$9, views=$10
  `, [t.id, t.slug, t.author, t.authorId || null, t.title, t.body,
      t.createdAt, t.lastActivityAt, t.replyCount, t.views]);
}

async function deleteForumThread(id) {
  await db('DELETE FROM forum_threads WHERE id = $1', [id]);
}

async function saveForumReply(r) {
  await db(`
    INSERT INTO forum_replies (id, thread_id, author, author_id, body, created_at)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING
  `, [r.id, r.threadId, r.author, r.authorId || null, r.body, r.createdAt]);
}

async function deleteForumReply(id) {
  await db('DELETE FROM forum_replies WHERE id = $1', [id]);
}


// ── Блог ──────────────────────────────────────────────────────
const blogPosts = [];

async function loadBlog() {
  const r = await db('SELECT * FROM blog_posts ORDER BY created_at DESC');
  for (const row of r.rows) {
    blogPosts.push({
      id: row.id, title: row.title, body: row.body, author: row.author,
      status: row.status, views: row.views, likes: row.likes,
      likedBy: row.liked_by || [],
      community: row.community || false,
      createdAt: Number(row.created_at), updatedAt: row.updated_at ? Number(row.updated_at) : null,
    });
  }
}

async function saveBlogPost(p) {
  // Просмотры/лайки сохраняются с задержкой (см. _viewTimer/_lstTimer ниже) —
  // если статью удалили, пока такой отложенный таймер ещё не сработал, он
  // всё равно вызовет saveBlogPost() через 5 секунд ПОСЛЕ удаления. Из-за
  // ON CONFLICT DO UPDATE это превращается в обычный INSERT (строки-то уже
  // нет), и удалённая статья "воскресает" в БД — а после рестарта сервера
  // снова появляется на сайте через loadBlog(). Флаг _deleted это глушит.
  if (p._deleted) return;
  await db(`
    INSERT INTO blog_posts (id, title, body, author, status, views, likes, liked_by, created_at, updated_at, community)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (id) DO UPDATE SET
      title=$2, body=$3, status=$5, views=$6, likes=$7, liked_by=$8, updated_at=$10, community=$11
  `, [p.id, p.title, p.body, p.author, p.status,
      p.views || 0, p.likes || 0, JSON.stringify(p.likedBy || []),
      p.createdAt, p.updatedAt || null, p.community || false]);
}

async function deleteBlogPost(id) {
  await db('DELETE FROM blog_posts WHERE id = $1', [id]);
}


// ── Новости (News) ───────────────────────────────────────────
// В отличие от блога (открыт любому зарегистрированному юзеру, макс
// 1 статья/день), новости пишут только авторы, назначенные владельцем
// (username 'chesshome'). См. также newsAuthors ниже и API-контракт в
// комментарии наверху public/news.html.
const newsPosts = [];

async function loadNews() {
  const r = await db('SELECT * FROM news_posts ORDER BY created_at DESC');
  for (const row of r.rows) {
    newsPosts.push({
      id: row.id, title: row.title, body: row.body, author: row.author,
      status: row.status, views: row.views, likes: row.likes, dislikes: row.dislikes,
      cover: row.cover || '',
      createdAt: Number(row.created_at), updatedAt: row.updated_at ? Number(row.updated_at) : null,
    });
  }
}

async function saveNewsPost(p) {
  // См. аналогичный комментарий в saveBlogPost — тот же паттерн отложенного
  // сохранения просмотров/лайков и защиты от "воскрешения" удалённой статьи.
  if (p._deleted) return;
  await db(`
    INSERT INTO news_posts (id, title, body, author, status, views, likes, dislikes, cover, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (id) DO UPDATE SET
      title=$2, body=$3, status=$5, views=$6, likes=$7, dislikes=$8, cover=$9, updated_at=$11
  `, [p.id, p.title, p.body, p.author, p.status,
      p.views || 0, p.likes || 0, p.dislikes || 0, p.cover || '',
      p.createdAt, p.updatedAt || null]);
}

async function deleteNewsPost(id) {
  await db('DELETE FROM news_posts WHERE id = $1', [id]);
}


// Список авторов новостей: username в исходном регистре, назначаются/снимаются
// владельцем (chesshome). Держим в памяти, синхронизируем с news_authors.
const newsAuthors = [];

async function loadNewsAuthors() {
  const r = await db('SELECT username FROM news_authors ORDER BY created_at ASC');
  newsAuthors.length = 0;
  newsAuthors.push(...r.rows.map(row => row.username));
}


const server = http.createServer(app);

const io     = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (!origin || origin === SITE_URL) return cb(null, true);
      return cb(null, false);
    },
    methods: ['GET','POST','DELETE','PATCH'],
    credentials: true,
  },
  // perMessageDeflate жмёт каждый пакет на CPU отправителя и получателя.
  // На 1 ядре с частыми событиями (тиканье часов раз в секунду и т.п.)
  // это ощутимая CPU-нагрузка ради экономии небольшого трафика — отключаем.
  perMessageDeflate: false,
  maxHttpBufferSize: 64 * 1024,
});


const PORT       = process.env.PORT || 10000;

const JWT_SECRET = process.env.JWT_SECRET;

// Базовый URL сайта: используется для whitelist CORS/Socket.IO origin.
const SITE_URL   = process.env.SITE_URL || 'https://chesshome.pro';

const RESERVED   = ['chesshome', 'admin', 'moderator', 'system', 'система'];


// ── Системные сообщения ─────────────────────────────────────────
// Отправитель для широковещательных/точечных сообщений от админа.
// Это не настоящий аккаунт (ник зарезервирован в RESERVED выше) —
// "системность" сообщения определяется только по полю from_user.
const SYSTEM_SENDER = 'Система';

function isSystemSender(name) { return !!name && name.toLowerCase() === SYSTEM_SENDER.toLowerCase(); }


const sessions          = new Map();

// username(lowercase) -> socket.id — быстрый O(1) поиск сокета по нику.
const usernameToSocketId = new Map();

const onlineUsers       = new Set();

const pendingChallenges = [];

// activeGames / tournamentGames — в services/game.service.js


// ── ПУЛ ДОМАШНИХ WORKER'ОВ (ваши ПК) ────────────────────────────
// Каждый воркер — обычное исходящее socket.io-подключение с вашего ПК
// (не нужно открывать порты/иметь белый IP), аутентифицируется секретом
// из .env. Поддерживается СРАЗУ НЕСКОЛЬКО воркеров одновременно —
// у каждого подключения свой socket.id, так что просто запускайте
// скрипт на нескольких машинах с одним и тем же WORKER_SECRET.
// Каждый воркер сообщает, сколько потоков он готов использовать
// (настраивается в .env самого воркера, см. worker-client/.env.example).
// Работоспособность сайта никогда не зависит от воркеров: если все
// выключены, анализ просто идёт локально в браузере посетителя, как
const workers = new Map();
      // socket.id -> { socket, threads, busy, lastSeen }
const analyzeJobs = new Map();
  // jobId -> { requesterSocketId, workerSocketId }

function pickIdleWorker() {
  for (const w of workers.values()) { if (!w.busy) return w; }
  return null;
}


// ── IP-БАН middleware ─────────────────────────────────────────
function ipBanMiddleware(req, res, next) {
  const ip = getIP(req);
  const deviceId = req.deviceId; // сервер сам выдаёт и хранит device id в HttpOnly-cookie
  const p = req.path;

  if (p.includes('/register') || p.includes('/verify-email')) {
    if (bannedIPs.has(ip))
      return res.status(403).json({ error: 'Регистрация с вашего IP временно ограничена.' });
    if (deviceId && bannedDevices.has(deviceId))
      return res.status(403).json({ error: 'Это устройство заблокировано. Создание новых аккаунтов запрещено.' });
  }

  next();
}

// ipBanMiddleware подключается ТОЛЬКО в цепочках маршрутов /api/register


// ── Получение реального IP клиента ───────────────────────────
// Порядок приоритетов:
//   1. req.ip  — Express разбирает x-forwarded-for сам после app.set('trust proxy', 2)
//                и возвращает уже проверенный реальный IP (безопасно, спуфинг невозможен)
//   2. x-forwarded-for — берём первый IP из списка (крайний левый = клиент)
//   3. x-real-ip       — Nginx часто выставляет это поле напрямую
//   4. socket.remoteAddress — прямое соединение (без прокси / локальный запуск)
// Заголовки x-real-ip / x-forwarded-for доверяем ТОЛЬКО если TCP-сосед — наш
// прокси (loopback или приватная сеть: nginx на этой же машине / docker bridge).
// Иначе любой клиент, обратившийся к Node напрямую, подделает свой IP.
function isTrustedProxyPeer(peer) {
  if (!peer || typeof peer !== 'string') return false;
  const p = peer.startsWith('::ffff:') ? peer.slice(7) : peer;
  if (p === '::1' || p === '127.0.0.1' || p.startsWith('127.')) return true;
  if (p.startsWith('10.') || p.startsWith('192.168.')) return true;
  const m = /^172\.(\d{1,2})\./.exec(p);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(p)) return true; // IPv6 ULA fc00::/7
  return false;
}
function cleanIpHeader(v) {
  if (typeof v !== 'string') return null;
  const ip = v.split(',')[0].trim();
  return require('net').isIP(ip) ? ip : null;
}
function getIP(req) {
  // 1) req.ip — Express сам разбирает x-forwarded-for по trust proxy.
  // 2) fallback — только x-real-ip и только от доверенного прокси
  const peer = req.socket?.remoteAddress;
  return req.ip
    || (isTrustedProxyPeer(peer) ? cleanIpHeader(req.headers['x-real-ip']) : null)
    || peer
    || 'unknown';
}

function isLocalIP(ip) {
  if (!ip || ip === 'unknown') return true;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  if (ip.startsWith('::ffff:127.')) return true;
  return false;
}


// ── VPN / Proxy / Tor детект ──────────────────────────────────
const vpnCheckCache = new Map();

const VPN_CACHE_TTL = 60 * 60 * 1000;


async function isVpnOrProxy(ip) {
  if (isLocalIP(ip)) return false;
  const cached = vpnCheckCache.get(ip);
  if (cached && Date.now() - cached.cachedAt < VPN_CACHE_TTL) {
    return cached.result;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const resp = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=proxy,hosting,tor`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    const data = await resp.json();
    const isVpn = !!(data.proxy || data.hosting || data.tor);
    vpnCheckCache.set(ip, { result: isVpn, cachedAt: Date.now() });
    if (isVpn) console.log(`[VPN block] ${ip} — proxy:${data.proxy} hosting:${data.hosting} tor:${data.tor}`);
    return isVpn;
  } catch (e) {
    console.warn('[VPN check] Ошибка проверки IP:', ip, e.message);
    return false;
  }
}

function rateLimit(limiter, message = 'Слишком много запросов. Подождите немного.') {
  return (req, res, next) => {
    const ip = getIP(req);
    const result = limiter.check(ip);
    res.set('X-RateLimit-Limit', result.max);
    res.set('X-RateLimit-Remaining', Math.max(0, result.max - result.count));
    if (!result.allowed) {
      console.warn(`[RateLimit] ${ip} blocked (${result.count}/${result.max})`);
      return res.status(429).json({ error: message });
    }
    next();
  };
}


// ── Безопасность заголовков ───────────────────────────────────
app.use((req, res, next) => {
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://mc.yandex.ru; " +
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; " +
    "font-src 'self' data: https://fonts.gstatic.com; " +
    "img-src 'self' data: blob: https:; " +
    "connect-src 'self' wss: ws: https://mc.yandex.ru; " +
    "worker-src 'self' blob:; " +
    "frame-ancestors 'self'; " +
    "base-uri 'self'; form-action 'self'");
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origin === SITE_URL) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
}));

app.use(compression());

// Лимит поднят с 50kb: статьи блога разрешены до 100 000 символов
// (см. проверку body.length в POST /api/blog), а это уже само по себе
// 100-400кб в зависимости от алфавита. При старом лимите body-parser
// рубил запрос ДО того, как код успевал вернуть свою красивую ошибку
// "Текст слишком длинный", и в некоторых окружениях (за прокси без
// финального error-хендлера) это отдавало клиенту HTML вместо JSON —
// отсюда "JSON.parse: unexpected character at line 1 column 1".
app.use(express.json({ limit: '2mb' }));

app.use(express.urlencoded({ extended: false, limit: '2mb' }));

app.use((req, res, next) => {
    if (req.path.match(/\.(css|js|svg|png|ico|woff|woff2|map)$/)) return next();
    if (!limiterGeneral.check(getIP(req)).allowed)
      return res.status(429).json({ error: 'Слишком много запросов. Подождите немного.' });
  next();
});


app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || !req.path.includes('.')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});


// ── Cache-busting для /js/*.js внутри HTML ─────────────────────
// Проблема, которую это решает: браузер кэширует /js/app.js на 1 час
// (см. maxAge статики ниже). HTML при этом всегда отдаётся свежим
// (no-store), но <script src="/js/app.js"> — это один и тот же URL,
// поэтому после деплоя пользователи до часа могли получать старый
// app.js, хотя страница уже новая (отсюда "ReferenceError: X is not
// defined" после обновления кода).
//
// BUILD_VERSION генерируется один раз при старте процесса. Деплой =
// перезапуск сервера => новая версия => во всех отдающихся HTML
// автоматически подставляется новый ?v=..., браузер воспринимает это
// как новый URL и гарантированно скачивает свежий файл, игнорируя
// старый закэшированный. Уже открытые у пользователей вкладки этим не
// затронуты (их не заставить перезагрузиться), но любая новая загрузка/
// обновление страницы получает актуальный код.
const BUILD_VERSION = Date.now();

const JS_SRC_RE = /(<script\b[^>]*\bsrc=["'])(\/js\/[^"']+\.js)(["'])/g;


function sendVersionedHtml(res, filePath) {
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return res.status(404).end();
    const versioned = html.replace(JS_SRC_RE, `$1$2?v=${BUILD_VERSION}$3`);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(versioned);
  });
}


// Подменяем res.sendFile для .html-ответов на версию с подстановкой ?v=,
// чтобы не переписывать вручную каждый из ~40 app.get(...).sendFile(...)
// ниже по файлу — они продолжают работать как есть.
app.use((req, res, next) => {
  const originalSendFile = res.sendFile.bind(res);
  res.sendFile = function (filePath, ...args) {
    if (typeof filePath === 'string' && filePath.endsWith('.html')) {
      return sendVersionedHtml(res, filePath);
    }
    return originalSendFile(filePath, ...args);
  };
  next();
});


app.use(express.static(path.join(__dirname, '../public'), {
  maxAge: '1h',
  etag: true,
  index: false,
}));


const LICHESS_TOKEN = process.env.LICHESS_API_TOKEN;


const loginFailStreaks = new Map();
 // 'username_low|ip' -> { count, resetAt }
const USERNAME_FAIL_WINDOW_MS = 15 * 60 * 1000;
const USERNAME_FAIL_TOTAL_MAX = 30;
const usernameFailTotals = new Map();
 // username_low -> { count, resetAt }
function pruneFailWindow(map, now) {
  for (const [k, v] of map.entries()) if (now > v.resetAt) map.delete(k);
}
setInterval(() => {
  const now = Date.now();
  pruneFailWindow(loginFailStreaks, now);
  pruneFailWindow(usernameFailTotals, now);
}, 10 * 60 * 1000).unref();

// Сколько неудач уже у этой пары (ник, IP)
function getLoginFailStreak(usernameLow, ip) {
  const now = Date.now();
  const entry = loginFailStreaks.get(usernameLow + '|' + (ip || 'unknown'));
  if (!entry || now > entry.resetAt) return 0;
  return entry.count;
}

// Сколько суммарно неудач у ника со всех IP (для анти-распределённого брутфорса)
function getUsernameFailTotal(usernameLow) {
  const now = Date.now();
  const entry = usernameFailTotals.get(usernameLow);
  if (!entry || now > entry.resetAt) return 0;
  return entry.count;
}

// До какого значения (мс) лочен ник целиком, либо 0
function getUsernameLockUntil(usernameLow) {
  const now = Date.now();
  const entry = usernameFailTotals.get(usernameLow);
  if (!entry || now > entry.resetAt) return 0;
  return entry.count >= USERNAME_FAIL_TOTAL_MAX ? entry.resetAt : 0;
}

function bumpLoginFailStreak(usernameLow, ip) {
  const now = Date.now();
  const key = usernameLow + '|' + (ip || 'unknown');
  const entry = loginFailStreaks.get(key);
  if (!entry || now > entry.resetAt) {
    loginFailStreaks.set(key, { count: 1, resetAt: now + USERNAME_FAIL_WINDOW_MS });
  } else {
    entry.count++;
  }
  const total = usernameFailTotals.get(usernameLow);
  if (!total || now > total.resetAt) {
    usernameFailTotals.set(usernameLow, { count: 1, resetAt: now + USERNAME_FAIL_WINDOW_MS });
  } else {
    total.count++;
  }
}

function clearLoginFailStreak(usernameLow, ip) {
  loginFailStreaks.delete(usernameLow + '|' + (ip || 'unknown'));
  // Общий счётчик ника при УСПЕШНОМ входе сбрасываем только если он не лочен —
  // иначе 29 неудач + 1 успех обнуляли бы прогресс анти-брутфорса.
  const total = usernameFailTotals.get(usernameLow);
  if (total && total.count < USERNAME_FAIL_TOTAL_MAX) usernameFailTotals.delete(usernameLow);
}

// per-user (не per-IP) лимит: не больше 5 попыток в минуту на аккаунт —
// внутри транзакции всё равно защищено FOR UPDATE + total_crystals_updated_at,
// но это не даёт одному аккаунту засыпать пул запросами.
const limiterQuests = new RateLimiter(60_000, 5);


async function handleDeleteChatMsg(req, res) {
  await requireAdmin(req, res, async () => {
    const idx = globalChat.findIndex(m => m.id === req.params.msgId);
    const removed = idx !== -1 ? globalChat[idx] : null;
    if (idx !== -1) globalChat.splice(idx, 1);
    let r = null;
    try { r = await deleteChatMsg(req.params.msgId); }
    catch (e) {
      console.error('[DeleteChatMsg] SQL:', e.message);
      if (idx === -1) return res.status(500).json({ error: 'Ошибка удаления' });
    }
    // 404 — только если сообщения нет НИ в кэше, НИ в БД.
    if (idx === -1 && (!r || r.rowCount === 0)) {
      return res.status(404).json({ error: 'Не найдено' });
    }
    await logAdminAction(req.user.username, 'chat_delete', removed?.username || null, { msgId: req.params.msgId, text: (removed?.message || '').slice(0, 200) });
    io.emit('chat_msg_deleted', req.params.msgId);
    res.json({ ok: true });
  });
}


// Вынесено в отдельную функцию (services/chat.service.js), чтобы вызывать
// и из ручного удаления, и автоматически при бане пользователя (см. /api/admin/ban).


async function handleUpdateReportStatus(req, res) {
  await requireAdmin(req, res, async () => {
    try {
      const status = req.body.status || 'reviewed';
      const r = await db('UPDATE reports SET status=$1, reviewed_by=$2, reviewed_at=$3 WHERE id=$4',
        [status, req.user.username, Date.now(), req.params.reportId]);
      if (r.rowCount === 0) {
        return res.status(404).json({ error: 'Жалоба не найдена (возможно, неверный id)' });
      }
      await logAdminAction(req.user.username, 'report_status', req.params.reportId, { status });
      res.json({ ok: true });
    } catch (e) {
      console.error('[Reports PATCH]', e.message);
      res.status(500).json({ error: 'Ошибка обновления статуса: ' + e.message });
    }
  });
}

// ── Апелляции / обращения (тикеты) ─────────────────────────────
// Правило: пока не ответит вторая сторона, писать снова нельзя —
// поле `awaiting` хранит, чья очередь отвечать ('admin' | 'user').
// Закрытые тикеты блокируют переписку до тех пор, пока админ не
// откроет их заново через PATCH.
const APPEAL_REASONS = ['ban', 'cheater', 'rating', 'other'];


async function handleUpdateAppealStatus(req, res) {
  await requireAdmin(req, res, async () => {
    try {
      const status = req.body.status;
      if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'Некорректный статус' });
      const r = await db(`SELECT id FROM appeals WHERE id = $1`, [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });

      const now = Date.now();
      if (status === 'open') {
        // Реоткрытие — очередь снова переходит к пользователю
        await db(`UPDATE appeals SET status='open', awaiting='user', updated_at=$1 WHERE id=$2`, [now, req.params.id]);
      } else {
        await db(`UPDATE appeals SET status='closed', updated_at=$1 WHERE id=$2`, [now, req.params.id]);
      }
      await logAdminAction(req.user.username, 'appeal_status', req.params.id, { status });
      res.json({ ok: true });
    } catch (e) {
      console.error('[Appeals PATCH]', e);
      res.status(500).json({ error: 'Ошибка обновления статуса обращения' });
    }
  });
}


async function handleEditTournament(req, res) {
  await requireTournamentManager(req, res, async (t) => {
    if (getTournamentStatus(t, Date.now()) === 'finished') return res.status(400).json({ error: 'Турнир завершён' });
    const b = req.body || {};
    const upd = {};
    if (b.name !== undefined) {
      const n = String(b.name).trim().slice(0, 60);
      if (!n) return res.status(400).json({ error: 'Название не может быть пустым' });
      upd.name = n;
    }
    if (b.description !== undefined) upd.description = String(b.description || '').trim().slice(0, 1000);
    if (b.timeControl !== undefined) {
      if (typeof b.timeControl !== 'string' || !/^\d{1,3}(\.\d)?\+\d{1,2}(s)?$/.test(b.timeControl)) {
        return res.status(400).json({ error: 'Неверный контроль времени (формат «10+0», «3+2»)' });
      }
      upd.timeControl = b.timeControl;
    }
    if (b.durationMinutes !== undefined) {
      const d = parseInt(b.durationMinutes, 10);
      if (!Number.isFinite(d)) return res.status(400).json({ error: 'Неверная длительность' });
      upd.durationMinutes = Math.max(5, Math.min(d, 7 * 24 * 60));
    }
    if (b.maxParticipants !== undefined) {
      let m = parseInt(b.maxParticipants, 10);
      if (!Number.isFinite(m) || m < 0) m = 0;
      upd.maxParticipants = Math.min(m, 512);
    }
    if (b.minRating !== undefined || b.maxRating !== undefined) {
      let lo = b.minRating !== undefined ? parseInt(b.minRating, 10) : t.minRating;
      let hi = b.maxRating !== undefined ? parseInt(b.maxRating, 10) : t.maxRating;
      if (!Number.isFinite(lo) || lo < 0) lo = 0;
      if (!Number.isFinite(hi) || hi <= 0) hi = 9999;
      if (lo > hi) { const tmp = lo; lo = hi; hi = tmp; }
      upd.minRating = lo; upd.maxRating = hi;
    }
    if (b.startsAt) {
      const st = new Date(b.startsAt).getTime();
      if (!Number.isFinite(st)) return res.status(400).json({ error: 'Неверная дата начала' });
      upd.startsAt = st;
    }
    if (Array.isArray(b.teamLinks) && b.teamLinks.length > 500) {
      return res.status(400).json({ error: 'Слишком много ссылок на команды' });
    }
    Object.assign(t, upd);
    // Старт перенесли в будущее — сбрасываем флаг «старт уже обработан», иначе при
    // новом старте участников не поставят в очередь и пары не создадутся.
    if (upd.startsAt !== undefined && upd.startsAt > Date.now()) delete t._startNotified;
    if (upd.startsAt !== undefined || upd.durationMinutes !== undefined) {
      t.endsAt = t.startsAt + t.durationMinutes * 60000;
    }
    if (Array.isArray(req.body.blacklist)) t.blacklist = req.body.blacklist.map(s => String(s).toLowerCase().trim()).filter(Boolean).slice(0, 100);
    // Редактирование списка команд межклубного турнира (только для isInterclub турниров,
    // requireTournamentManager уже гарантирует, что сюда попадёт только сайт-админ).
    if (t.isInterclub && Array.isArray(req.body.teamLinks)) {
      const { teamIds, notFound } = resolveInterclubTeams(req.body.teamLinks);
      if (teamIds.length < 2) return res.status(400).json({ error: 'Нужно указать ссылки минимум на 2 клуба-команды' });
      if (teamIds.length > MAX_INTERCLUB_TEAMS) return res.status(400).json({ error: `Максимум ${MAX_INTERCLUB_TEAMS} команд в межклубном турнире` });
      if (notFound.length) return res.status(400).json({ error: `Не найдены клубы по ссылкам: ${notFound.slice(0, 10).join(', ')}` });
      // Нельзя убрать команду, за которую уже кто-то реально играет в этом турнире.
      const usedTeamIds = new Set((t.participants || []).filter(p => !p.left && p.teamId).map(p => p.teamId));
      for (const used of usedTeamIds) {
        if (!teamIds.includes(used)) {
          const club = clubs.find(c => c.id === used);
          return res.status(400).json({ error: `Нельзя убрать команду «${club ? club.name : used}» — за неё уже играют участники` });
        }
      }
      t.teamIds = teamIds;
    }
    await saveTournament(t);
    io.emit('tournament_updated', { id: t.id, name: t.name, startsAt: t.startsAt });
    res.json(t);
  });
}


async function handleDeleteTournament(req, res) {
  await requireTournamentManager(req, res, async (t) => {
    const idx = tournaments.findIndex(x => x.id === t.id);
    if (idx === -1) return res.status(404).json({ error: 'Не найден' });
    tournaments.splice(idx, 1);
    await deleteTournamentFromDB(t.id);
    io.emit('tournament_deleted', t.id);
    res.json({ ok: true });
  });
}


async function handleUnblacklistTournament(req, res) {
  await requireTournamentManager(req, res, async (t) => {
    t.blacklist = (t.blacklist || []).filter(u => u !== req.params.username.toLowerCase());
    await saveTournament(t);
    res.json({ ok: true, blacklist: t.blacklist });
  });
}


// ── DM: Личные Сообщения ──────────────────────────────────────
function dmRoomKey(a, b) { return [a.toLowerCase(), b.toLowerCase()].sort().join('::'); }


// ── Админ: просмотр переписок пользователя ──────────────────────
// Доступ только через requireAdmin (роль admin). Каждый просмотр
// пишется в admin_dm_audit (кто из админов, чью переписку и когда
// смотрел) — это не ограничивает доступ, но даёт возможность потом
// расследовать злоупотребления и отвечает перед пользователями за
// то, что доступ к их ЛС отслеживается.
async function logDmAudit(admin, target, partner, action) {
  try {
    await db('INSERT INTO admin_dm_audit (id, admin, target, partner, action, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [uuidv4(), admin, target, partner, action, Date.now()]);
  } catch (e) { console.error('[DM Audit]', e.message); }
}


// Общий лог действий админов — вызывается из всех модерационных
// эндпоинтов ниже (бан, IP-бан, VIP, задачи, чат, жалобы, обращения,
// системные сообщения и т.п.). details — произвольный объект,
// сохраняется как JSON-строка.
async function logAdminAction(admin, action, target, details) {
  try {
    await db('INSERT INTO admin_action_log (id, admin, action, target, details, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [uuidv4(), admin, action, target || null, details ? JSON.stringify(details) : null, Date.now()]);
  } catch (e) { console.error('[AdminLog]', e.message); }
}


// ── Forum API ─────────────────────────────────────────────────
function countTodayByUser(arr, username) {
  const midnight = new Date(); midnight.setHours(0,0,0,0);
  return arr.filter(x => x.author === username && x.createdAt >= midnight.getTime()).length;
}

function makeSlug(title, id) {
  const s = title.toLowerCase()
    .replace(/[а-яё]/g, c => ({а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'j',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'}[c]||''))
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'topic';
  return s + '-' + id.slice(0, 6);
}


const forumViewSessions = new Map();
const FORUM_VIEW_MAX_THREADS = 1000; // сколько тем держим в памяти
const FORUM_VIEW_MAX_VIEWERS = 5000; // сколько уникальных просмотрщиков на тему

// Возвращает true, если viewerKey для темы виден впервые (тему нужно
// +1 к счётчику просмотров), и в любом случае гарантирует соблюдение
// лимитов коллекции.
function trackForumView(threadId, viewerKey) {
  // Просроченные/удалённые темы постепенно выдавливаются лимитом MAX_THREADS.
  if (forumViewSessions.size >= FORUM_VIEW_MAX_THREADS && !forumViewSessions.has(threadId)) {
    const oldest = forumViewSessions.keys().next().value;
    if (oldest !== undefined) forumViewSessions.delete(oldest);
  }
  let viewers = forumViewSessions.get(threadId);
  if (!viewers) { viewers = new Set(); forumViewSessions.set(threadId, viewers); }
  if (viewers.has(viewerKey)) return false;
  if (viewers.size >= FORUM_VIEW_MAX_VIEWERS) return false; // Set полон — новые просмотрщики не копим
  viewers.add(viewerKey);
  return true;
}


async function handleUnfollow(req, res) {
  try {
    const target = await getUser(req.params.username.toLowerCase());
    const follower = req.user.username;
    const following = target ? target.username : req.params.username;
    await db(`DELETE FROM follows WHERE follower = $1 AND following = $2`, [follower, following]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Unfollow]', e);
    res.status(500).json({ error: 'Ошибка отписки' });
  }
}


// ── Blog API ──────────────────────────────────────────────────
function blogAuthMiddleware(req, res, next) {
  const auth = getAuthToken(req);
  if (!auth) return res.status(401).json({ error: 'Войдите, чтобы выполнить это действие' });
  try { req.blogUser = jwt.verify(auth, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Неверный токен' }); }
}

function isBlogAdmin(username) { return isSiteAdmin(username); }


// Заголовок и текст статьи блога иногда приезжают в base64 (поле encoding:'b64') —
// так фронтенд обходит ложные срабатывания WAF/ModSecurity на длинном сыром
// markdown-тексте (WAF видит бессмысленный base64 вместо спецсимволов и не блокирует
function decodeBlogField(value, encoding) {
  if (typeof value !== 'string' || encoding !== 'b64') return value;
  try { return Buffer.from(value, 'base64').toString('utf8'); }
  catch { return value; }
}


function blogSanitize(post, withBody) {
  const o = { id: post.id, title: post.title, author: post.author, status: post.status,
    views: post.views || 0, likes: post.likes || 0,
    community: !!post.community,
    createdAt: post.createdAt, updatedAt: post.updatedAt || null };
  if (withBody) o.body = post.body;
  return o;
}


async function handleDeleteBlogPost(req, res) {
  const idx = blogPosts.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Статья не найдена' });
  const post = blogPosts[idx];
  const caller = req.blogUser.username;
  if (!isBlogAdmin(caller) && post.author.toLowerCase() !== caller.toLowerCase())
    return res.status(403).json({ error: 'Нет доступа' });
  // Отменяем отложенные таймеры сохранения просмотров/лайков (см. комментарий
  // в saveBlogPost) — иначе они всплывут через 5 секунд ПОСЛЕ удаления и
  // заново вставят уже удалённую статью в БД.
  if (post._viewTimer) { clearTimeout(post._viewTimer); post._viewTimer = null; }
  if (post._lstTimer)  { clearTimeout(post._lstTimer);  post._lstTimer  = null; }
  post._deleted = true;
  blogPosts.splice(idx, 1);
  await deleteBlogPost(post.id);
  await db('DELETE FROM blog_likes WHERE post_id=$1',[post.id]).catch(()=>{});
  await db('DELETE FROM blog_views WHERE post_id=$1',[post.id]).catch(()=>{});
  res.json({ ok: true });
}


// ══════════════════════════════════════════════════════════════
//  BLOG COMMENTS API
// ══════════════════════════════════════════════════════════════

function isBlogCommentAdmin(username) {
  return isSiteAdmin(username);
}


async function getCommentBan(postId, username) {
  const uname = username.toLowerCase();
  const glob = await db('SELECT * FROM blog_global_comment_bans WHERE username=$1',[uname]);
  if (glob.rows[0]) {
    const r = glob.rows[0];
    if (r.type === 'ban' || (r.until && Number(r.until) > Date.now())) return r;
    await db('DELETE FROM blog_global_comment_bans WHERE username=$1',[uname]).catch(()=>{});
  }
  const local = await db('SELECT * FROM blog_comment_bans WHERE post_id=$1 AND username=$2',[postId,uname]);
  if (local.rows[0]) {
    const r = local.rows[0];
    if (r.type === 'ban' || (r.until && Number(r.until) > Date.now())) return r;
    await db('DELETE FROM blog_comment_bans WHERE post_id=$1 AND username=$2',[postId,uname]).catch(()=>{});
  }
  return null;
}


async function handleDeleteBlogComment(req, res) {
  const user = await getUser(req.blogUser.username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const r = await db('SELECT * FROM blog_comments WHERE id=$1 AND post_id=$2',[req.params.cid,req.params.id]);
  const comment = r.rows[0];
  if (!comment) return res.status(404).json({ error: 'Комментарий не найден' });

  const isAdmin = isBlogCommentAdmin(user.username);
  const isAuthor = comment.author.toLowerCase() === user.username.toLowerCase();
  if (!isAdmin && !isAuthor) return res.status(403).json({ error: 'Нет прав' });

  const deletedBy = isAdmin && !isAuthor ? user.username : null;
  await db('UPDATE blog_comments SET deleted=TRUE, deleted_by=$1 WHERE id=$2',[deletedBy, req.params.cid]);
  res.json({ ok: true, deletedBy });
}


// ══════════════════════════════════════════════════════════════
//  NEWS API
//  Контракт см. в комментарии наверху public/news.html.
//  В отличие от блога, публиковать новости может не любой юзер, а
//  только авторы, назначенные владельцем (username 'chesshome').
// ══════════════════════════════════════════════════════════════
function newsAuthMiddleware(req, res, next) {
  const auth = getAuthToken(req);
  if (!auth) return res.status(401).json({ error: 'Войдите, чтобы выполнить это действие' });
  try { req.newsUser = jwt.verify(auth, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Неверный токен' }); }
}


const NEWS_OWNER_USERNAME = 'chesshome';

function isNewsOwner(username) { return !!username && username.toLowerCase() === NEWS_OWNER_USERNAME; }

function isNewsAuthorUser(username) {
  if (!username) return false;
  if (isNewsOwner(username)) return true;
  const low = username.toLowerCase();
  return newsAuthors.some(a => a.toLowerCase() === low);
}


function newsSanitize(post, withBody) {
  const o = { id: post.id, title: post.title, author: post.author, status: post.status,
    cover: post.cover || '', views: post.views || 0, likes: post.likes || 0, dislikes: post.dislikes || 0,
    createdAt: post.createdAt, updatedAt: post.updatedAt || null };
  if (withBody) o.body = post.body;
  return o;
}


async function handleDeleteNewsPost(req, res) {
  const idx = newsPosts.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Новость не найдена' });
  const post = newsPosts[idx];
  const caller = req.newsUser.username;
  if (!isNewsOwner(caller) && post.author.toLowerCase() !== caller.toLowerCase())
    return res.status(403).json({ error: 'Нет доступа' });
  // См. аналогичный комментарий в handleDeleteBlogPost про отложенные таймеры.
  if (post._viewTimer) { clearTimeout(post._viewTimer); post._viewTimer = null; }
  if (post._lstTimer)  { clearTimeout(post._lstTimer);  post._lstTimer  = null; }
  post._deleted = true;
  newsPosts.splice(idx, 1);
  await deleteNewsPost(post.id);
  await db('DELETE FROM news_likes WHERE post_id=$1',[post.id]).catch(()=>{});
  await db('DELETE FROM news_dislikes WHERE post_id=$1',[post.id]).catch(()=>{});
  await db('DELETE FROM news_views WHERE post_id=$1',[post.id]).catch(()=>{});
  await db('DELETE FROM news_comments WHERE post_id=$1',[post.id]).catch(()=>{});
  await db('DELETE FROM news_comment_mutes WHERE post_id=$1',[post.id]).catch(()=>{});
  res.json({ ok: true });
}


// ══════════════════════════════════════════════════════════════
//  NEWS COMMENTS API
// ══════════════════════════════════════════════════════════════
async function getNewsCommentMute(postId, username) {
  const uname = username.toLowerCase();
  const r = await db('SELECT * FROM news_comment_mutes WHERE post_id=$1 AND username=$2',[postId,uname]);
  const row = r.rows[0];
  if (!row) return null;
  if (Number(row.until) > Date.now()) return row;
  await db('DELETE FROM news_comment_mutes WHERE post_id=$1 AND username=$2',[postId,uname]).catch(()=>{});
  return null;
}


async function handleDeleteNewsComment(req, res) {
  const user = await getUser(req.newsUser.username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const r = await db('SELECT * FROM news_comments WHERE id=$1 AND post_id=$2',[req.params.cid,req.params.id]);
  const comment = r.rows[0];
  if (!comment) return res.status(404).json({ error: 'Комментарий не найден' });

  const isOwnerCaller = isNewsOwner(user.username);
  const isAuthor = comment.author.toLowerCase() === user.username.toLowerCase();
  if (!isOwnerCaller && !isAuthor) return res.status(403).json({ error: 'Нет прав' });

  const deletedBy = isOwnerCaller && !isAuthor ? user.username : null;
  await db('UPDATE news_comments SET deleted=TRUE, deleted_by=$1 WHERE id=$2',[deletedBy, req.params.cid]);
  res.json({ ok: true, deletedBy });
}


// ── Загрузка изображений (обложки новостей) ──────────────────
const UPLOADS_DIR = path.join(__dirname, '../public/uploads');

try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (e) { console.error('[Upload] Не удалось создать папку uploads:', e.message); }


const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const extByMime = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
    cb(null, `${Date.now()}_${uuidv4()}${extByMime[file.mimetype] || '.bin'}`);
  },
});

// Magic bytes реальных изображений — проверка содержимого, а не декларации клиента.
const IMAGE_MAGIC = [
  { mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png',  bytes: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'image/gif',  bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF....WEBP — первые 4 байта + проверка 8-11
];
function sniffImageMime(buf) {
  for (const sig of IMAGE_MAGIC) {
    if (sig.bytes.every((b, i) => buf[i] === b)) {
      if (sig.mime === 'image/webp') {
        // Доп. проверка строки WEBP на смещении 8
        return buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 ? sig.mime : null;
      }
      return sig.mime;
    }
  }
  return null;
}

const uploadImage = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) return cb(new Error('Разрешены только изображения (jpeg, png, gif, webp)'));
    cb(null, true);
  },
});


async function handleEditClub(req, res) {
  const me = await getUser(req.user.username.toLowerCase());
  if (!me) return res.status(404).json({ error: 'Не найден' });
  const club = clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: 'Клуб не найден' });
  const isClubAdmin = (club.admins || []).map(a => a.toLowerCase()).includes(me.username.toLowerCase());
  const isSuperAdmin = me.username.toLowerCase() === 'chesshome' || me.role === 'admin';
  if (!isClubAdmin && !isSuperAdmin) return res.status(403).json({ error: 'Нет прав' });
  if (req.body.description !== undefined) club.description = req.body.description.toString().trim().slice(0, 500);
  await saveClub(club);
  res.json({ ok: true, club });
}


async function handleDeleteClub(req, res) {
  const me = await getUser(req.user.username.toLowerCase());
  if (!me) return res.status(404).json({ error: 'Не найден' });
  const idx = clubs.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Клуб не найден' });
  const club = clubs[idx];
  const isCreator = club.createdBy.toLowerCase() === me.username.toLowerCase();
  const isSuperAdmin = me.username.toLowerCase() === 'chesshome' || me.role === 'admin';
  if (!isCreator && !isSuperAdmin) return res.status(403).json({ error: 'Нет прав' });
  if (club.official && !isSuperAdmin) return res.status(403).json({ error: 'Нельзя удалить официальный клуб' });
  clubs.splice(idx, 1); await deleteClubFromDB(club.id); res.json({ ok: true });
}


// ══════════════════════════════════════════════════════════════
//  PUZZLE API
// ══════════════════════════════════════════════════════════════

// ── Квесты (Сезон 2) ─────────────────────────────────────────
const SEASON_NUMBER = 2;
// Старт сезона задаётся переменной окружения SEASON_START (ISO-дата);
// по умолчанию — 1 сентября 2026 UTC.
const SEASON_START = process.env.SEASON_START
  ? new Date(process.env.SEASON_START).getTime()
  : Date.UTC(2026, 8, 1);

function getCurrentSeasonDay() {
  const day = Math.floor((Date.now() - SEASON_START) / 86_400_000) + 1;
  return Math.max(1, day);
}

// Проверка секретного ключа скрипта (НЕ обычная сессия пользователя).
// Constant-time сравнение строк-секретов: обычное 'a !== b'short-circuit'ит
// на первом несовпадающем байте, что теоретически позволяет вычислять секрет
// побайтово по времени ответа. Хэшируем обе стороны SHA-256 — длины выравниваются,
// сравнение через timingSafeEqual становится безопасным.
function safeSecretEqual(a, b) {
  try {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  } catch (e) { return false; }
}


function durkaKeyMiddleware(req, res, next) {
  const key = process.env.DURKA_ADMIN_KEY;
  if (!key) return res.status(500).json({ error: 'DURKA_ADMIN_KEY не настроен на сервере' });
  if (typeof req.headers['x-durka-key'] !== 'string' || !safeSecretEqual(req.headers['x-durka-key'], key)) {
    return res.status(403).json({ error: 'Неверный ключ' });
  }
  next();
}


function parsePuzzleSolution(solution) {
  const all = (solution || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const playerMoves = all.filter((_, i) => i % 2 === 0);
  const autoMoves   = all.filter((_, i) => i % 2 === 1);
  return { all, playerMoves, autoMoves };
}


async function handleDeletePuzzle(req, res) {
  await requireAdmin(req, res, async () => {
    await db('DELETE FROM puzzles WHERE id=$1',[req.params.id]);
    await logAdminAction(req.user.username, 'puzzle_delete', req.params.id, {});
    res.json({ ok:true });
  });
}

// Регистрация маршрутов (страницы и API) вынесена в routes.js —
// в core.js только состояние, БД, хелперы и функции-контроллеры.


async function handleDeleteDevDiaryEntry(req, res) {
  try {
    const user = await getUser(req.user.username.toLowerCase());
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Доступ запрещён' });
    await db('DELETE FROM dev_diary WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DevDiary DELETE]', e);
    res.status(500).json({ error: 'Ошибка удаления записи: ' + e.message });
  }
}


async function handleDeleteDevDiaryComment(req, res) {
  try {
    const user = await getUser(req.user.username.toLowerCase());
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Нет прав' });
    await db(`DELETE FROM dev_diary_comments WHERE id=$1`, [req.params.commentId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}


// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════

const BANNED_ALLOWED_PATHS = [
  /^\/api\/me$/,
  /^\/api\/appeals(\/|$)/,
  /^\/api\/dev-diary\/[^/]+\/comments$/,
];
async function authMiddleware(req, res, next) {
  const auth = getAuthToken(req);
  if (!auth) return res.status(401).json({ error: 'Не авторизован' });
  let decoded;
  try { decoded = jwt.verify(auth, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Неверный токен' }); }
  req.user = decoded;
  try {
    const u = await getUser(String(decoded.username || '').toLowerCase());
    if (!u) return res.status(401).json({ error: 'Аккаунт не найден' });
    if (u.banned) {
      const p = String(req.originalUrl || req.url || '').split('?')[0];
      if (!BANNED_ALLOWED_PATHS.some(rx => rx.test(p))) {
        return res.status(403).json({ error: 'Аккаунт заблокирован' + (u.banReason ? ': ' + u.banReason : '') });
      }
    }
  } catch (e) {
    // БД недоступна: проверить бан/удаление аккаунта мы не можем. Чтение (GET/HEAD)
    // пропускаем, чтобы сайт не «падал» целиком, а ИЗМЕНЯЮЩИЕ запросы закрываем:
    // иначе забаненный пользователь с ещё живым JWT пишет в чат/ЛС/турниры
    console.error('[authMiddleware] БД недоступна:', e && e.message);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return res.status(503).json({ error: 'Сервис временно недоступен, попробуйте через минуту' });
    }
  }
  next();
}


async function requireAdmin(req, res, cb) {
  try {
    const me = await getUser(req.user.username.toLowerCase());
    if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Нет прав' });
    await cb();
  } catch (e) {
    console.error('[requireAdmin]', e);
    if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}


// VIP-проверка завязана на сайт-админов (см. isVipGranter выше):
// роль 'admin' в БД либо legacy-ники bootstrap. Роль выдаётся через
async function requireVipGranter(req, res, cb) {
  try {
    const me = await getUser(req.user.username.toLowerCase());
    if (!me || !isVipGranter(me.username)) return res.status(403).json({ error: 'Нет прав на выдачу VIP-значка' });
    await cb(me);
  } catch (e) {
    console.error('[requireVipGranter]', e);
    if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}


// viewerIsSelf: если true — перед нами сам владелец профиля, и статус
// теневого бана от него скрывается (banned=false), как будто ничего не
// произошло. Всем остальным (viewerIsSelf=false/не передан) теневой бан
// показывается точно так же, как обычный banned — с той же меткой "БАН"
// в интерфейсе — потому что для окружающих разницы нет.
function sanitizeUser(u, viewerIsSelf = false) {
  const shadowVisible = !!u.shadowBanned && !viewerIsSelf;
  return {
    id: u.id, username: u.username, rating: u.rating,
    gamesPlayed: u.gamesPlayed, wins: u.wins, losses: u.losses, draws: u.draws,
    createdAt: u.createdAt, avatar: u.avatar, role: u.role || 'user',
    banned: (u.banned || shadowVisible) || false,
    banReason: (u.banned ? u.banReason : (shadowVisible ? (u.shadowBanReason || 'Нарушение правил') : null)) || null,
    puzzle_rating: u.puzzle_rating ?? 1200, puzzle_solved: u.puzzle_solved ?? 0,
    puzzle_attempted: u.puzzle_attempted ?? 0, emoji: u.emoji || '',
    bio: u.bio || '', fshrRating: u.fshrRating ?? null, fideRating: u.fideRating ?? null,
    vip: isVip(u), vipUntil: isVip(u) ? u.vipUntil : null,
    badges: getUserBadges(u),
  };
}


function adminSanitizeUser(u) {
  return { ...sanitizeUser(u, false), email: u.email || null, createdFromIP: u.createdFromIP || null, createdDeviceId: u.createdDeviceId || null, vipUntil: u.vipUntil ?? null, shadowBanned: u.shadowBanned || false, shadowBanReason: u.shadowBanReason || null };
}


// getInterclubTeamsInfo / computeTeamStandings / sanitizeTournament /
// getTournamentStatus — в services/tournament.service.js


function verifyToken(t) { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } }


function findSocketByUsername(username) {
  // Было: линейный перебор всей карты sessions на каждый вызов (O(n)).
  // Стало: прямой доступ по индексу usernameToSocketId (O(1)).
  //
  // Multi-socket: у юзера может быть несколько легитимных сокетов одновременно
  // (основной app.js + DM-сокет header.js). Возвращаем fanout-эмиттер: emit()
  // доставляет событие ВСЕМ сокетам юзера, disconnect() отключает все. Все
  // существующие вызовы вида s?.emit(...) / if (sock) sock.emit(...) работают
  // без изменений — но больше не зависят от того, какой из сокетов юзера
  const low = String(username).toLowerCase();
  const ids = usernameToSocketId.get(low);
  if (!ids || ids.size === 0) return null;
  const sockets = [];
  for (const id of ids) {
    const s = io.sockets.sockets.get(id);
    if (s) sockets.push(s);
  }
  if (!sockets.length) { usernameToSocketId.delete(low); return null; }
  return {
    emit(event, ...args) { for (const s of sockets) s.emit(event, ...args); },
    disconnect()         { for (const s of sockets) s.disconnect(true); },
    get size()           { return sockets.length; },
  };
}


// ── Приватные события только для админов ──────────────────────
async function emitToAdmins(event, payload) {
  // Multi-socket: у одного админа может быть несколько сокетов/сессий —
  // дедуплицируем по нику, чтобы каждый админ получил событие один раз.
  const seen = new Set();
  for (const [, sess] of sessions.entries()) {
    const low = sess.username.toLowerCase();
    if (seen.has(low)) continue;
    const u = usersCache.get(low);
    if (u?.role !== 'admin') continue;
    seen.add(low);
    const sock = findSocketByUsername(sess.username);
    if (sock) sock.emit(event, payload);
  }
}


const limiterSocketConnect = new RateLimiter(60_000, 200);


async function main() {
  if (!JWT_SECRET || typeof JWT_SECRET !== 'string' || JWT_SECRET.length < 32 || /change_me|changeme|secret$/i.test(JWT_SECRET)) {
    console.error('❌ FATAL: JWT_SECRET не задан/слишком короткий/дефолтный. Сгенерируйте сильный секрет и укажите его в .env:');
    console.error("   node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"");
    process.exit(1);
  }

  console.log('🐘 Подключение к PostgreSQL...');
  await pool.query('SELECT 1');
  console.log('✅ PostgreSQL подключён');

  await loadBansFromDB();
  await loadChat();
  await loadTournaments();
  await loadTournamentChats();
  await loadClubs();
  await loadClubChats();
  await loadForum();
  await loadBlog();
  await loadNewsAuthors();
  await loadNews();

  if (!clubs.find(c => c.id === 'chesshome-official')) {
    const offClub = { id: 'chesshome-official', name: 'ChessHome', description: 'Официальный клуб шахматной платформы Chess Home.', createdAt: Date.now(), createdBy: 'ChessHome', admins: ['ChessHome'], members: ['ChessHome'], memberCount: 1, official: true };
    clubs.push(offClub); await saveClub(offClub);
  }
  for (const adminName of ['chesshome', 'marina64']) {
    const u = await getUser(adminName);
    if (u && u.role !== 'admin') { u.role = 'admin'; await saveUser(u); console.log(`[Admin] Подтверждён администратор: ${u.username}`); }
  }
  server.listen(PORT, () => {
    console.log(`♟️  Chess Home: http://localhost:${PORT}`);

    process.on('SIGINT',  () => { pool.end(); console.log('\nЗавершение работы...'); process.exit(0); });
    process.on('SIGTERM', () => { pool.end(); process.exit(0); });
  });
}

// ── Экспорт всего, что нужно routes.js и sockets.js ────────────
Object.assign(module.exports, {
  express,
  http,
  Server,
  compression,
  bcrypt,
  jwt,
  uuidv4,
  path,
  fs,
  cors,
  pool,
  db,
  withTransaction,
  BAD_NICK_WORDS,
  normNick,
  nickHasBadWord,
  PROFILE_EMOJIS,
  normForSimilarity,
  app,
  parseCookieHeader,
  isProd,
  AUTH_COOKIE_OPTS,
  DEVICE_COOKIE_OPTS,
  getAuthToken,
  RateLimiter,
  limiterGeneral,
  limiterAuth,
  limiterStrict,
  socketLimiter,
  limiterRegStrict,
  STORM_DURATION_MS,
  STORM_MAX_TIME_MS,
  STORM_MIN_MS_PER_PUZZLE,
  stormRuns,
  bannedIPs,
  bannedDevices,
  loadBansFromDB,
  saveBanToDB,
  removeBanFromDB,
  usersCache,
  cacheUser,
  rowToUser,
  isVip,
  isVipGranter,
  USER_BADGES,
  getUserBadges,
  getUser,
  saveUser,
  globalChat,
  loadChat,
  saveChatMsg,
  deleteChatMsg,
  tournaments,
  loadTournaments,
  saveTournament,
  deleteTournamentFromDB,
  clubs,
  loadClubs,
  saveClub,
  deleteClubFromDB,
  CLUB_CHAT_MAX,
  clubChats,
  clubChatBans,
  getClubChat,
  getClubChatBans,
  loadClubChats,
  saveClubChatMsg,
  deleteClubChatMsgsByUser,
  isSiteAdmin,
  isClubModerator,
  canManageTournament,
  MAX_INTERCLUB_TEAMS,
  extractClubIdFromLink,
  resolveInterclubTeams,
  requireTournamentManager,
  canWriteInClubChat,
  TOURNAMENT_CHAT_MAX,
  TOURNAMENT_CHAT_READONLY_AFTER_MS,
  tournamentChats,
  tournamentChatMutes,
  getTournamentChat,
  getTournamentChatMutes,
  isTournamentChatOpen,
  canModerateTournamentChat,
  loadTournamentChats,
  saveTournamentChatMsg,
  wipeTournamentChatMsgsByUser,
  forumThreads,
  forumReplies,
  loadForum,
  saveForumThread,
  deleteForumThread,
  saveForumReply,
  deleteForumReply,
  blogPosts,
  loadBlog,
  saveBlogPost,
  deleteBlogPost,
  newsPosts,
  loadNews,
  saveNewsPost,
  deleteNewsPost,
  newsAuthors,
  loadNewsAuthors,
  server,
  io,
  PORT,
  JWT_SECRET,
  RESERVED,
  SYSTEM_SENDER,
  isSystemSender,
  sessions,
  usernameToSocketId,
  onlineUsers,
  pendingChallenges,
  activeGames,
  tournamentGames,
  workers,
  analyzeJobs,
  pickIdleWorker,
  ipBanMiddleware,
  getIP,
  isLocalIP,
  isTrustedProxyPeer,
  cleanIpHeader,
  vpnCheckCache,
  VPN_CACHE_TTL,
  isVpnOrProxy,
  rateLimit,
  BUILD_VERSION,
  JS_SRC_RE,
  sendVersionedHtml,
  LICHESS_TOKEN,
  SITE_URL,
  sniffImageMime,
  loginFailStreaks,
  getLoginFailStreak,
  getUsernameFailTotal,
  getUsernameLockUntil,
  bumpLoginFailStreak,
  clearLoginFailStreak,
  limiterQuests,
  handleDeleteChatMsg,
  removeUserChatMessages,
  handleUpdateReportStatus,
  APPEAL_REASONS,
  handleUpdateAppealStatus,
  handleEditTournament,
  handleDeleteTournament,
  handleUnblacklistTournament,
  dmRoomKey,
  logDmAudit,
  logAdminAction,
  countTodayByUser,
  makeSlug,
  forumViewSessions,
  trackForumView,
  handleUnfollow,
  blogAuthMiddleware,
  isBlogAdmin,
  decodeBlogField,
  blogSanitize,
  handleDeleteBlogPost,
  isBlogCommentAdmin,
  getCommentBan,
  handleDeleteBlogComment,
  newsAuthMiddleware,
  NEWS_OWNER_USERNAME,
  isNewsOwner,
  isNewsAuthorUser,
  newsSanitize,
  handleDeleteNewsPost,
  getNewsCommentMute,
  handleDeleteNewsComment,
  UPLOADS_DIR,
  uploadStorage,
  uploadImage,
  handleEditClub,
  handleDeleteClub,
  getCurrentSeasonDay,
  durkaKeyMiddleware,
  safeSecretEqual,
  parsePuzzleSolution,
  handleDeletePuzzle,
  handleDeleteDevDiaryEntry,
  handleDeleteDevDiaryComment,
  authMiddleware,
  requireAdmin,
  requireVipGranter,
  sanitizeUser,
  adminSanitizeUser,
  getInterclubTeamsInfo,
  computeTeamStandings,
  sanitizeTournament,
  getTournamentStatus,
  verifyToken,
  liveClock,
  hasFullMove,
  endGameAuthoritative,
  findSocketByUsername,
  emitToAdmins,
  recordGame,
  updateStats,
  REMATCH_GRACE_PERIOD,
  tryPairTournamentPlayers,
  FIRST_MOVE_TIMEOUT,
  startTournamentGame,
  finishTournamentGame,
  anticheatBan,
  startGame,
  serverChess,
  limiterSocketConnect,
  main,
});
