// ═══════════════════════════════════════════════════════════════
//  core.js — общее состояние сервера
// ═══════════════════════════════════════════════════════════════
// Всё, от чего зависят и routes.js, и sockets.js: подключение к БД,
// Express-приложение (app), Socket.IO (io), кэши в памяти (юзеры,
// чаты, турниры, клубы...), константы и все хелперы/миддлвары.
//
// routes.js и sockets.js просто делают:
//   const { app, io, db, ... } = require('./core');
// и используют эти же самые объекты — состояние по-настоящему общее,
// это НЕ копии.
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

const { Pool } = require('pg');

// npm install multer — обработка multipart/form-data для загрузки обложек новостей.
const multer  = require('multer');

require('dotenv').config();


// ── PostgreSQL ────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });


async function db(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}


// ── Атомарные транзакции ──────────────────────────────────────
// В отличие от db(), который берёт НОВОЕ соединение на каждый вызов
// (а значит BEGIN/INSERT/UPDATE/COMMIT через db() выполняются на разных
// соединениях и НЕ являются одной транзакцией), withTransaction держит
// ОДНО соединение на весь колбэк: BEGIN, все запросы и COMMIT/ROLLBACK
// идут через один и тот же client.
//
// Использование:
//   await withTransaction(async (client) => {
//     await client.query('INSERT INTO ...', [...]);
//     await client.query('UPDATE ...', [...]);
//   });
// При исключении внутри колбэка — автоматический ROLLBACK, ошибка
// пробрасывается наверх. client.release() вызывается всегда.
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}


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
// произвольным текстом. Раньше проверялся только чёрный список
// ("запрещённые" эмодзи) — любой юзер, дёрнув /api/user/emoji
// напрямую (мимо UI, через devtools/curl), мог отправить любую
// строку. Теперь допускается ТОЛЬКО то, что есть в этом списке
// (тот же набор, что показан в /settings).
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
// Раньше клиент сам генерировал и хранил ch_device_id в localStorage,
// откуда его можно было прочитать (XSS) или просто удалить/подделать
// перед регистрацией нового аккаунта. Теперь id выпускает сервер
// и кладёт в HttpOnly-cookie — JS на странице не может ни прочитать,
// ни стереть его вручную.
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
    // Защита памяти (issue M4): store индексируется по IP-строке. При атаке с
    // большого числа адресов (ботнет / IPv6 /64) карт может вырасти до
    // миллионов записей за окно — OOM на маленьком инстансе. Ограничиваем:
    // при переполнении вытесняется самая старая запись (Map итерируется в
    // порядке вставки — это честный FIFO).
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

// Брутфорс (issue H2): было 1000/мин на IP (~17 паролей/сек). В связке с
// проверкой loginFailStreak в /api/login — 20/мин достаточно для людей,
// но делает онлайн-перебор паролей бессмысленным.
const limiterAuth      = new RateLimiter(60_000,    20);

const limiterStrict    = new RateLimiter(60_000,    900);

const socketLimiter    = new RateLimiter(10_000,   1000);

const limiterRegStrict = new RateLimiter(3_600_000, 1000);


// ── PUZZLE STORM: серверный трекинг забегов ─────────────────────
// Score раньше принимался от клиента как есть — можно было прислать
// в консоли браузера {score: 20000} и получить любой рекорд. Теперь
// сервер сам засекает старт забега (runId) и на финише проверяет,
// что результат физически достижим за прошедшее время.
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
    // Безопасность (issue H1): раньше ошибка только логалась коротко и сервер
    // продолжал работу с ПУСТЫМИ списками банов — при отсутствующих таблицах
    // (чистый деплой; схема не была в репозитории) все баны «пропадали» молча.
    // Теперь отсутствие таблиц даёт громкий fatal-подсказку в лог.
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

// Защита памяти (issue M5/«сервер захлёбывается» #91): usersCache пополняется
// при каждом getUser() и НИКОГДА не чистился — при росте числа посетителей
// весь сайт медленно съедал ОЗУ. Теперь у кэша мягкий предел: при переполнении
// вытесняется самая старая запись (FIFO). Вытесненный пользователь просто
// будет перечитан из БД при следующем getUser() — корректность не страдает.
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
  // Рассинхронизация (БАГ исправлен): раньше cacheUser(u) вызывался ДО записи в БД —
  // при ошибке запроса кэш оставался с новыми данными, а БД со старыми, вплоть
  // до рестарта сервера. Теперь кэш обновляется только после успешной записи.
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


// ── Кэш глобального чата ──────────────────────────────────────
const globalChat = [];

async function loadChat() {
  const r = await db(`
    SELECT * FROM (SELECT * FROM chat_messages ORDER BY timestamp DESC LIMIT 500) sub ORDER BY timestamp ASC
  `);
  for (const row of r.rows) {
    globalChat.push({
      id: row.id,
      username: row.username,
      message: row.message,
      role: row.role,
      timestamp: Number(row.timestamp),
      shadowHidden: row.shadow_hidden || false,
      emoji: row.emoji || '',
      vip: row.vip || false,
    });
  }
}

async function saveChatMsg(msg) {
  await db('INSERT INTO chat_messages (id, username, message, role, timestamp, shadow_hidden, emoji, vip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
    [msg.id, msg.username, msg.message, msg.role || 'user', msg.timestamp, msg.shadowHidden || false, msg.emoji || '', msg.vip || false]);
}

async function deleteChatMsg(msgId) {
  // Возвращаем результат запроса: обработчику удаления нужен rowCount,
  // чтобы отличить «сообщение было только в БД» от «нигде не найдено».
  return await db('DELETE FROM chat_messages WHERE id = $1', [msgId]);
}


// ── Турниры ───────────────────────────────────────────────────
const tournaments = [];

async function loadTournaments() {
  const r = await db('SELECT * FROM tournaments ORDER BY starts_at ASC');
  for (const row of r.rows) {
    tournaments.push({
      id: row.id, name: row.name, description: row.description,
      timeControl: row.time_control,
      durationMinutes: row.duration_minutes,
      startsAt: Number(row.starts_at), endsAt: Number(row.ends_at),
      maxParticipants: row.max_participants, minRating: row.min_rating, maxRating: row.max_rating,
      blacklist: row.blacklist, createdBy: row.created_by, createdAt: Number(row.created_at),
      participants: row.participants, games: row.games, winner: row.winner,
      // Клубные турниры: привязка к клубу и ограничение только для его участников
      clubId: row.club_id || null, clubOnly: !!row.club_only,
      // Межклубные турниры: список команд (id клубов), участвующих в турнире.
      // Создавать такие турниры может только сайт-админ (см. requireAdmin ниже).
      isInterclub: !!row.is_interclub, teamIds: row.team_ids || [],
    });
  }
}

async function saveTournament(t) {
  await db(`
    INSERT INTO tournaments (id, name, description, time_control, duration_minutes,
      starts_at, ends_at, max_participants, min_rating, max_rating,
      blacklist, created_by, created_at, participants, games, winner, club_id, club_only,
      is_interclub, team_ids)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    ON CONFLICT (id) DO UPDATE SET
      name=$2, description=$3, time_control=$4, duration_minutes=$5,
      starts_at=$6, ends_at=$7, max_participants=$8, min_rating=$9, max_rating=$10,
      blacklist=$11, participants=$14, games=$15, winner=$16, club_id=$17, club_only=$18,
      is_interclub=$19, team_ids=$20
  `, [t.id, t.name, t.description || null, t.timeControl, t.durationMinutes,
      t.startsAt, t.endsAt, t.maxParticipants, t.minRating, t.maxRating,
      JSON.stringify(t.blacklist || []), t.createdBy, t.createdAt,
      JSON.stringify(t.participants || []), JSON.stringify(t.games || []), t.winner || null,
      t.clubId || null, !!t.clubOnly,
      !!t.isInterclub, JSON.stringify(t.teamIds || [])]);
}

async function deleteTournamentFromDB(id) {
  await db('DELETE FROM tournaments WHERE id = $1', [id]);
}


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


// ── Чаты клубов ───────────────────────────────────────────────
const CLUB_CHAT_MAX = 30;

const clubChats = new Map();

const clubChatBans = new Map();


function getClubChat(clubId) {
  if (!clubChats.has(clubId)) clubChats.set(clubId, []);
  return clubChats.get(clubId);
}

function getClubChatBans(clubId) {
  if (!clubChatBans.has(clubId)) clubChatBans.set(clubId, new Map());
  return clubChatBans.get(clubId);
}


async function initClubChatTable() {
  await db(`
    CREATE TABLE IF NOT EXISTS club_chat_messages (
      id          TEXT PRIMARY KEY,
      club_id     TEXT NOT NULL,
      username    TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'user',
      message     TEXT NOT NULL,
      timestamp   BIGINT NOT NULL,
      is_system   BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  await db(`CREATE INDEX IF NOT EXISTS idx_club_chat_club_id ON club_chat_messages(club_id, timestamp DESC)`);
}


async function loadClubChats() {
  const r = await db(`
    SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY club_id ORDER BY timestamp DESC) AS rn
      FROM club_chat_messages) t WHERE rn <= ${CLUB_CHAT_MAX} ORDER BY timestamp ASC
  `);
  for (const row of r.rows) {
    const chat = getClubChat(row.club_id);
    chat.push({
      id: row.id, username: row.username, role: row.role,
      message: row.message, timestamp: Number(row.timestamp),
      system: row.is_system || false,
    });
  }
}


async function saveClubChatMsg(clubId, msg) {
  try {
    await db(`
      INSERT INTO club_chat_messages (id, club_id, username, role, message, timestamp, is_system)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING
    `, [msg.id, clubId, msg.username, msg.role || 'user', msg.message,
        msg.timestamp, msg.system || false]);
    await db(`
      DELETE FROM club_chat_messages
      WHERE club_id = $1 AND id NOT IN (
        SELECT id FROM club_chat_messages
        WHERE club_id = $1 ORDER BY timestamp DESC LIMIT ${CLUB_CHAT_MAX}
      )
    `, [clubId]);
  } catch (e) { console.error('[saveClubChatMsg] error:', e.message); }
}


async function deleteClubChatMsgsByUser(clubId, usernameLow) {
  try {
    await db(`DELETE FROM club_chat_messages WHERE club_id=$1 AND LOWER(username)=$2`, [clubId, usernameLow]);
  } catch (e) { console.error('[deleteClubChatMsgsByUser] error:', e.message); }
}

// Сайт-админ: источник истины — роль 'admin' в БД (users.role). Она:
//  1) подтверждается на старте для legacy-ников bootstrap (см. main()),
//  2) выдаётся/снимается через POST /api/admin/role (issue #27).
// Legacy-ники ['chesshome','marina64'] — fallback на холодный старт,
// пока пользователь ещё не загружен в usersCache.
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


// ── Межклубные турниры ──────────────────────────────────────────
// Отдельная разновидность турнира: несколько клубов ("команд") заявлены
// заранее (по ссылкам на их страницы), создать такой турнир может только
// сайт-админ, участвовать можно только за клуб, в котором реально состоишь,
// а игроки одной команды никогда не спариваются друг с другом.
const MAX_INTERCLUB_TEAMS = 175;


// Достаём id клуба из ссылки вида ".../clubs/<id>" или принимаем "голый" id как есть.
function extractClubIdFromLink(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/\/clubs\/([^\/?#]+)/i);
  if (m) { try { return decodeURIComponent(m[1]).trim(); } catch { return m[1].trim(); } }
  return s;
}


// Разбирает присланный список ссылок/id команд, убирает дубли и невалидные значения.
// Возвращает { teamIds, notFound } — notFound содержит то, что не удалось сопоставить с клубом.
function resolveInterclubTeams(rawLinks) {
  const arr = Array.isArray(rawLinks) ? rawLinks : [];
  const teamIds = [];
  const notFound = [];
  const seen = new Set();
  for (const raw of arr) {
    const id = extractClubIdFromLink(raw);
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const club = clubs.find(c => c.id === id);
    if (!club) { notFound.push(String(raw)); continue; }
    teamIds.push(club.id);
  }
  return { teamIds, notFound };
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


// ── Чат турниров ──────────────────────────────────────────────
// Открыт для сообщений до турнира, во время и ещё 3 часа после его
// окончания — дальше доступно только чтение (история из последних
// TOURNAMENT_CHAT_MAX сообщений).
const TOURNAMENT_CHAT_MAX = 50;

const TOURNAMENT_CHAT_READONLY_AFTER_MS = 3 * 60 * 60 * 1000;

const tournamentChats = new Map();
      // tId -> [{id, username, role, message, timestamp, system, muted}]
const tournamentChatMutes = new Map();
  // tId -> Map(usernameLow -> { until })

function getTournamentChat(tId) {
  if (!tournamentChats.has(tId)) tournamentChats.set(tId, []);
  return tournamentChats.get(tId);
}

function getTournamentChatMutes(tId) {
  if (!tournamentChatMutes.has(tId)) tournamentChatMutes.set(tId, new Map());
  return tournamentChatMutes.get(tId);
}

function isTournamentChatOpen(t, now) {
  return now < (t.endsAt + TOURNAMENT_CHAT_READONLY_AFTER_MS);
}

// Модератор чата турнира: сайт-админ, админ клуба (если турнир клубный)
// ИЛИ создатель конкретно этого турнира.
function canModerateTournamentChat(user, t) {
  if (!user) return false;
  if (canManageTournament(user, t)) return true;
  return !!(t.createdBy && user.username.toLowerCase() === t.createdBy.toLowerCase());
}


async function initTournamentChatTable() {
  await db(`
    CREATE TABLE IF NOT EXISTS tournament_chat_messages (
      id            TEXT PRIMARY KEY,
      tournament_id TEXT NOT NULL,
      username      TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'user',
      message       TEXT NOT NULL,
      timestamp     BIGINT NOT NULL,
      is_system     BOOLEAN NOT NULL DEFAULT FALSE,
      is_muted      BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  await db(`CREATE INDEX IF NOT EXISTS idx_tournament_chat_tid ON tournament_chat_messages(tournament_id, timestamp DESC)`);
}


async function loadTournamentChats() {
  const r = await db(`
    SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY tournament_id ORDER BY timestamp DESC) AS rn
      FROM tournament_chat_messages) t WHERE rn <= ${TOURNAMENT_CHAT_MAX} ORDER BY timestamp ASC
  `);
  for (const row of r.rows) {
    const chat = getTournamentChat(row.tournament_id);
    chat.push({
      id: row.id, username: row.username, role: row.role,
      message: row.message, timestamp: Number(row.timestamp),
      system: row.is_system || false, muted: row.is_muted || false,
    });
  }
}


async function saveTournamentChatMsg(tId, msg) {
  try {
    await db(`
      INSERT INTO tournament_chat_messages (id, tournament_id, username, role, message, timestamp, is_system, is_muted)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING
    `, [msg.id, tId, msg.username, msg.role || 'user', msg.message,
        msg.timestamp, msg.system || false, msg.muted || false]);
    await db(`
      DELETE FROM tournament_chat_messages
      WHERE tournament_id = $1 AND id NOT IN (
        SELECT id FROM tournament_chat_messages
        WHERE tournament_id = $1 ORDER BY timestamp DESC LIMIT ${TOURNAMENT_CHAT_MAX}
      )
    `, [tId]);
  } catch (e) { console.error('[saveTournamentChatMsg] error:', e.message); }
}


// Мут: не удаляет сообщения пользователя, а стирает их текст, заменяя на
// «[Замучен]» — история чата (кто когда писал) остаётся видна, но содержимое скрыто.
async function wipeTournamentChatMsgsByUser(tId, usernameLow) {
  const chat = getTournamentChat(tId);
  const affectedIds = [];
  for (const m of chat) {
    if ((m.username || '').toLowerCase() === usernameLow && !m.system) {
      m.message = '[Замучен]';
      m.muted = true;
      affectedIds.push(m.id);
    }
  }
  try {
    await db(`UPDATE tournament_chat_messages SET message = '[Замучен]', is_muted = TRUE WHERE tournament_id=$1 AND LOWER(username)=$2`, [tId, usernameLow]);
  } catch (e) { console.error('[wipeTournamentChatMsgsByUser] error:', e.message); }
  return affectedIds;
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
  // Безопасность (issue M6): раньше origin: '*' — любой сайт мог подключать
  // сокет от имени посетителя и свободно читать API. При самом запросе сокет
  // не отправляет cookies сторонним origin (sameSite=lax), но открытый
  // '*' всё равно расширяет поверхность. Разрешаем только собственный домен.
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
  // Безопасность (issue M9): дефолтный лимит полезной нагрузки 1MB на
  // сообщение при щедрых rate-limit'ах — вектор на исчерпание памяти/CPU.
  // Легитимные события (ходы, чат, вызовы) — сотни байт, 64KB с запасом.
  maxHttpBufferSize: 64 * 1024,
});


const PORT       = process.env.PORT || 10000;

const JWT_SECRET = process.env.JWT_SECRET;

// Базовый URL сайта: используется для whitelist CORS/Socket.IO origin.
// (Раньше переменная использовалась только донатами ЮKassa — теперь это общая
// конфигурация сайта; в .env её указывать не обязательно.)
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
// Раньше findSocketByUsername() и поиск "старой" сессии при auth
// линейно перебирали ВСЮ карту sessions на каждый вызов (это происходит
// каждую секунду для каждой активной партии — тик часов, плюс при каждом
// tournament-тике раз в 3с на каждого участника, плюс emitToAdmins и т.д.)
// При росте числа онлайн-пользователей и партий это O(n) в горячем пути.
const usernameToSocketId = new Map();

const onlineUsers       = new Set();

const pendingChallenges = [];

const activeGames       = new Map();

const tournamentGames   = new Map();


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
// было раньше (см. analyze_request ниже и фолбэк в stockfish-ui.js).
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

  // Мёртвый код удалён: раньше здесь JWT верифицировался, юзер грузился из БД
  // (ход в кэш/БД на КАЖДЫЙ запрос!), а тело проверки было пустым
  // if (user && user.banned) { } — ноускоп. Бан проверяется глобально
  // в authMiddleware на защищённых роутах (getUser + banned).
  next();
}

// ipBanMiddleware подключается ТОЛЬКО в цепочках маршрутов /api/register
// и /api/login в routes.js (раньше он дублировался здесь глобальным
// app.use и выполнялся дважды на каждый запрос).


// ── Получение реального IP клиента ───────────────────────────
// Порядок приоритетов:
//   1. req.ip  — Express разбирает x-forwarded-for сам после app.set('trust proxy', 2)
//                и возвращает уже проверенный реальный IP (безопасно, спуфинг невозможен)
//   2. x-forwarded-for — берём первый IP из списка (крайний левый = клиент)
//   3. x-real-ip       — Nginx часто выставляет это поле напрямую
//   4. socket.remoteAddress — прямое соединение (без прокси / локальный запуск)
function getIP(req) {
  return req.ip
    || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
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
  // CSP (issue M10): раньше заголовка не было вообще, при этом значительная часть
  // фронтенда собирается через innerHTML — CSP служит последней линией обороны
  // от XSS (см. фиксы валидации promotion/gameId). Источники подобраны по факту:
  // jsdelivr (marked/purify), Google Fonts, Яндекс.Метрика; инлайн-скрипты —
  // 'unsafe-inline', пока страницы рендерят server-side <script> с данными партии.
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

// CORS (issue M6): раньше app.use(cors()) открывал API всем origin. Сайтовый
// фронтенд live на том же домене (кулбы за same-origin), поэтому достаточно
// разрешить собственный домен (+ не-браузерные клиенты без Origin). Кросс-
// доменные запросы всё равно не несли cookies (sameSite=lax) — теперь и читаемость
// API извне закрыта.
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
  // Раньше статика (js/css/картинки/шрифты) отдавалась без Cache-Control —
  // каждый клиент дергал сервер за одними и теми же файлами на каждой
  // загрузке страницы. maxAge даёт браузеру право не перезапрашивать файл
  // повторно в течение часа, что на 1 ядре и 100 юзерах заметно снижает
  // число обслуживаемых HTTP-запросов. HTML по-прежнему no-store (см. выше).
  // index:false — index.html отдаём вручную (см. app.get('/') выше), чтобы
  // он тоже проходил через версионирование /js/*.js.
  maxAge: '1h',
  etag: true,
  index: false,
}));


const LICHESS_TOKEN = process.env.LICHESS_API_TOKEN;



// ── ЮKassa — мёртвый код УДАЛЁН ──────────────────────────────
// Платежи вырезаны из продукта (хедер ведёт на CloudTips, donate.html не
// существует, фронтенд не вызывает ни один /api/donate/* роут). Удалены:
// константы YUKASSA_SHOP_ID/YUKASSA_SECRET_KEY, таблица donations
// (initDonateTable) и все роуты /api/donate/* в routes.js.
// SITE_URL теперь объявлен вверху файла рядом с PORT/JWT_SECRET — он
// используется whitelist'ом CORS/Socket.IO.


// Раньше не было выделенного лимита на /login — только общий limiterGeneral
// (10000 запросов/мин на IP), что позволяло ~166 попыток пароля/сек с одного IP.
//
// Блокировка входа (issue H2): счётчик неудач был привязан ТОЛЬКО к нику.
// Это позволяло третьему лицу за 5 неверных паролей ЗАЛОЧИТЬ ВХОД ЛЮБОМУ
// пользователю на 15 минут (дёшевая DoS-атака на конкретного человека).
// Теперь ключ — связка «ник + IP»: 5 неудач лочат пару (ник, IP), при этом
// с одного IP нельзя брутфорсить чужой пароль (5 попыток/15 мин на аккаунт),
// а жертва с другого адреса входит как обычно. От распределённого перебора
// (много IP × один ник) защищает второй счётчик — usernameFailTotals:
// 30 неудач с разных IP за 15 минут лочат ник целиком (bcrypt cost 10 делает
// такой перебор бессмысленным, а легитимный пользователь при этом не
// страдает от 5-минутного коврового лока).
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
    // Удаление из БД (P1): раньше при отсутствии сообщения в кэше globalChat
    // отдавался 404 ДО запроса к БД, и после рестарта сервера (или вытеснения
    // сообщения лимитом в 500) админ не мог удалить сообщение — оно навсегда
    // оставалось в chat_messages и вновь попадало в кэш при следующем запуске.
    // Теперь SQL-удаление выполняется всегда, а кэш чистится синхронно, если
    // сообщение там было.
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


// Вынесено в отдельную функцию, чтобы вызывать и из ручного удаления,
// и автоматически при бане пользователя (см. /api/admin/ban).
async function removeUserChatMessages(username) {
  const toRemove = globalChat.filter(m => m.username === username).map(m => m.id);
  for (let i = globalChat.length - 1; i >= 0; i--) {
    if (globalChat[i].username === username) globalChat.splice(i, 1);
  }
  for (const id of toRemove) {
    await deleteChatMsg(id).catch(() => {});
  }
  if (toRemove.length) io.emit('chat_msgs_user_deleted', username);
  return toRemove.length;
}


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
    ['name','description','timeControl','durationMinutes','maxParticipants','minRating','maxRating'].forEach(k => { if (req.body[k] !== undefined) t[k] = req.body[k]; });
    if (req.body.startsAt) { t.startsAt = new Date(req.body.startsAt).getTime(); t.endsAt = t.startsAt + t.durationMinutes * 60000; }
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


// Утечка памяти (P1): раньше forumViewSessions рос бесконечно — Map держал
// Set просмотрщиков для КАЖДОЙ темы (включая удалённые) и никогда не чистился,
// уникальные ip/юзеры копились в Set месяцами. Теперь коллекция ограничена:
// максимум тем в Map и максимум просмотрщиков в одном Set; при переполнении
// вытесняется самая старая запись (FIFO — Map итерируется в порядке вставки).
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
    // Используем канонический регистр ника, если он найден в БД — раньше отписка
    // сравнивала строки с учётом регистра, из-за чего при малейшем несовпадении
    // регистра (например, ссылка вела на "Ivan", а подписка была на "ivan")
    // DELETE не находил нужную строку и кнопка "молча" не работала.
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
// запрос). Раскодируем здесь один раз, дальше код работает с обычным текстом как раньше.
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


db(`CREATE TABLE IF NOT EXISTS blog_views (viewer_key TEXT NOT NULL, post_id TEXT NOT NULL, PRIMARY KEY (viewer_key, post_id))`).catch(e => console.error('[Blog] blog_views init:', e.message));

db(`CREATE TABLE IF NOT EXISTS blog_likes (user_id TEXT NOT NULL, post_id TEXT NOT NULL, PRIMARY KEY (user_id, post_id))`).catch(e => console.error('[Blog] blog_likes init:', e.message));

db(`ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS community BOOLEAN DEFAULT FALSE`).catch(() => {});

db(`CREATE TABLE IF NOT EXISTS blog_comments (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at BIGINT NOT NULL, deleted BOOLEAN NOT NULL DEFAULT FALSE, deleted_by TEXT, edit_count INT NOT NULL DEFAULT 0, edited_at BIGINT)`).catch(e => console.error('[Blog] blog_comments init:', e.message));

db(`ALTER TABLE blog_comments ADD COLUMN IF NOT EXISTS edit_count INT NOT NULL DEFAULT 0`).catch(()=>{});

db(`ALTER TABLE blog_comments ADD COLUMN IF NOT EXISTS edited_at BIGINT`).catch(()=>{});

db(`CREATE INDEX IF NOT EXISTS idx_blog_comments_post ON blog_comments(post_id, created_at ASC)`).catch(() => {});

db(`CREATE TABLE IF NOT EXISTS blog_comment_reactions (comment_id TEXT NOT NULL, user_id TEXT NOT NULL, emoji TEXT NOT NULL, PRIMARY KEY (comment_id, user_id))`).catch(e => console.error('[Blog] blog_comment_reactions init:', e.message));

// Реакции на ответах форума (issue #45)
db(`CREATE TABLE IF NOT EXISTS forum_reply_reactions (reply_id TEXT NOT NULL, username_low TEXT NOT NULL, emoji TEXT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (reply_id, username_low))`).catch(e => console.error('[Forum] forum_reply_reactions init:', e.message));
db(`CREATE INDEX IF NOT EXISTS idx_forum_reply_reactions_reply ON forum_reply_reactions(reply_id)`).catch(() => {});

// Ответы на личные сообщения (issue #56): колонка reply_to_id в dm_messages.
// Таблица dm_messages создаётся прод-миграцией, поэтому при её отсутствии
// ALTER молча пропускается (фича ЛС при этом всё равно недоступна).
db(`ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS reply_to_id TEXT`).catch(() => {});

db(`CREATE TABLE IF NOT EXISTS blog_comment_bans (post_id TEXT NOT NULL, username TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'mute', until BIGINT, created_at BIGINT NOT NULL, PRIMARY KEY (post_id, username))`).catch(e => console.error('[Blog] blog_comment_bans init:', e.message));

db(`CREATE TABLE IF NOT EXISTS blog_global_comment_bans (username TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'mute', until BIGINT, created_at BIGINT NOT NULL)`).catch(e => console.error('[Blog] blog_global_comment_bans init:', e.message));


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


db(`CREATE TABLE IF NOT EXISTS news_posts (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', views INT NOT NULL DEFAULT 0,
  likes INT NOT NULL DEFAULT 0, dislikes INT NOT NULL DEFAULT 0, cover TEXT DEFAULT '',
  created_at BIGINT NOT NULL, updated_at BIGINT
)`).catch(e => console.error('[News] news_posts init:', e.message));

db(`CREATE TABLE IF NOT EXISTS news_authors (username TEXT NOT NULL, username_low TEXT PRIMARY KEY, created_at BIGINT NOT NULL)`).catch(e => console.error('[News] news_authors init:', e.message));

db(`CREATE TABLE IF NOT EXISTS news_views (viewer_key TEXT NOT NULL, post_id TEXT NOT NULL, PRIMARY KEY (viewer_key, post_id))`).catch(e => console.error('[News] news_views init:', e.message));

db(`CREATE TABLE IF NOT EXISTS news_likes (user_id TEXT NOT NULL, post_id TEXT NOT NULL, PRIMARY KEY (user_id, post_id))`).catch(e => console.error('[News] news_likes init:', e.message));

db(`CREATE TABLE IF NOT EXISTS news_dislikes (user_id TEXT NOT NULL, post_id TEXT NOT NULL, PRIMARY KEY (user_id, post_id))`).catch(e => console.error('[News] news_dislikes init:', e.message));

db(`CREATE TABLE IF NOT EXISTS news_comments (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at BIGINT NOT NULL, deleted BOOLEAN NOT NULL DEFAULT FALSE, deleted_by TEXT)`).catch(e => console.error('[News] news_comments init:', e.message));

db(`CREATE INDEX IF NOT EXISTS idx_news_comments_post ON news_comments(post_id, created_at ASC)`).catch(() => {});

db(`CREATE TABLE IF NOT EXISTS news_comment_mutes (post_id TEXT NOT NULL, username TEXT NOT NULL, until BIGINT NOT NULL, created_at BIGINT NOT NULL, PRIMARY KEY (post_id, username))`).catch(e => console.error('[News] news_comment_mutes init:', e.message));


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
    // Безопасность (issue H3): расширение НЕ берём из оригинального имени файла
    // (клиентский контроль) — выводим его из проверенного mimetype. Так
    // shell.html с mimetype=image/jpeg не сохранится как .html: получит .jpg.
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

async function initPuzzleTables() {
  try {
    await db(`CREATE TABLE IF NOT EXISTS puzzles (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
      fen TEXT NOT NULL, solution TEXT NOT NULL, topic TEXT NOT NULL,
      difficulty TEXT DEFAULT 'medium', created_by TEXT DEFAULT 'system',
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())*1000)::BIGINT,
      play_count INT DEFAULT 0, correct_count INT DEFAULT 0
    )`);
    await db(`CREATE TABLE IF NOT EXISTS puzzle_topics (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL,
      description TEXT, sort_order INT DEFAULT 0
    )`);
    await db(`CREATE TABLE IF NOT EXISTS puzzle_attempts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, puzzle_id TEXT NOT NULL,
      correct BOOLEAN NOT NULL,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())*1000)::BIGINT,
      UNIQUE(user_id, puzzle_id)
    )`);
    await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS puzzle_rating INT DEFAULT 1200`);
    await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS puzzle_solved INT DEFAULT 0`);
    await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS puzzle_attempted INT DEFAULT 0`);
    await db(`CREATE INDEX IF NOT EXISTS idx_puzzles_topic ON puzzles(topic)`);
    await db(`CREATE INDEX IF NOT EXISTS idx_puzzle_attempts_user ON puzzle_attempts(user_id)`);
    const topics = [
      ['mate1','Мат в 1 ход','♟','Найди единственный ход, ставящий мат',1],
      ['mate2','Мат в 2 хода','♞','Комбинация из двух ходов с матом',2],
      ['fork','Вилка','⚔️','Атакуй две фигуры одновременно',3],
      ['pin','Связка','📌','Обездвижь фигуру соперника',4],
      ['skewer','Рентген','🎯','Атакуй сильную фигуру через слабую',5],
      ['discovery','Открытый удар','💥','Открой атаку своей фигурой',6],
      ['endgame','Эндшпиль','👑','Техническое завершение партии',7],
      ['tactics','Тактика','⚡','Разные тактические мотивы',8],
    ];
    for (const [id,name,icon,desc,order] of topics) {
      await db(`INSERT INTO puzzle_topics (id,name,icon,description,sort_order) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,[id,name,icon,desc,order]);
    }
    await db(`CREATE TABLE IF NOT EXISTS puzzle_storm_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      score INT NOT NULL DEFAULT 0,
      total_attempted INT NOT NULL DEFAULT 0,
      correct INT NOT NULL DEFAULT 0,
      wrong INT NOT NULL DEFAULT 0,
      time_bonus INT NOT NULL DEFAULT 0,
      created_at BIGINT DEFAULT (EXTRACT(EPOCH FROM NOW())*1000)::BIGINT
    )`);
    await db(`CREATE INDEX IF NOT EXISTS idx_storm_user ON puzzle_storm_runs(user_id)`);
    await db(`CREATE INDEX IF NOT EXISTS idx_storm_score ON puzzle_storm_runs(score DESC)`);
    await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS storm_best INT DEFAULT 0`);
    await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS storm_runs INT DEFAULT 0`);
    await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS emoji TEXT DEFAULT ''`);
    console.log('[Puzzles] Таблицы инициализированы');
  } catch(e) { console.error('[Puzzles] init error:', e.message); }
}


// ══════════════════════════════════════════════════════════════
//  DURKA — сводный лидерборд по результатам lichess-турниров
// ══════════════════════════════════════════════════════════════
//  Как это работает:
//  1) durka_tournaments      — какие турниры уже засчитаны (защита от повторного начисления).
//  2) durka_tournament_results — очки каждого игрока в каждом отдельном турнире (для истории/аудита).
//  3) durka_players          — сумма очков по всем засчитанным турнирам (то, что видно на /durka).
//
//  Очки закидывает скрипт hi.py, который дергает Lichess API и шлёт
//  результат сюда через POST /api/durka/add-tournament с секретным
//  ключом в заголовке x-durka-key (см. DURKA_ADMIN_KEY в .env).
//  Обычная сессия/логин тут не нужен — скрипт работает с сервера напрямую.

// ── Квесты (Сезон 2) ─────────────────────────────────────────
// Таблицы квестов раньше вообще не создавались — /api/quests/* падали
// с 500 (после чего ещё и getCurrentSeasonDay была не определена).
// Здесь: схема + сид сезонных квестов + вычисление текущего дня сезона.
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

async function initQuestTables() {
  try {
    await db(`
      CREATE TABLE IF NOT EXISTS quests (
        id             TEXT PRIMARY KEY,
        day            INT  NOT NULL,
        title          TEXT NOT NULL,
        description    TEXT,
        reward_crystals INT NOT NULL DEFAULT 10,
        is_mega        BOOLEAN NOT NULL DEFAULT FALSE,
        type           TEXT NOT NULL DEFAULT 'manual'
      )
    `);
    await db(`
      CREATE TABLE IF NOT EXISTS user_quests (
        user_id      TEXT NOT NULL,
        quest_id     TEXT NOT NULL,
        completed_at BIGINT NOT NULL,
        progress     INT NOT NULL DEFAULT 0,
        target       INT NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, quest_id)
      )
    `);
    await db(`CREATE INDEX IF NOT EXISTS idx_user_quests_user ON user_quests(user_id)`);
    await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS total_crystals BIGINT NOT NULL DEFAULT 0`);
    await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS total_crystals_updated_at BIGINT NOT NULL DEFAULT 0`);
    // Сид квестов: по одному на каждый из 30 дней сезона. Каждый 7-й день —
    // мега-квест с увеличенной наградой.
    const questsSeed = [];
    for (let day = 1; day <= 30; day++) {
      const isMega = day % 7 === 0;
      questsSeed.push([
        `s${SEASON_NUMBER}d${day}`,
        day,
        isMega ? `Мега-квест дня ${day}` : `Квест дня ${day}`,
        isMega
          ? 'Особое задание дня — повышенная награда в кристаллах'
          : 'Ежедневное задание сезона — выполняй и получай кристаллы',
        isMega ? 50 : 10 + day,
        isMega,
        'confirm',
      ]);
    }
    for (const [id, day, title, description, reward, isMega, type] of questsSeed) {
      await db(
        `INSERT INTO quests (id, day, title, description, reward_crystals, is_mega, type)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [id, day, title, description, reward, isMega, type]
      );
    }
  } catch (e) { console.error('[Quests] init error:', e.message); }
}


async function initDurkaTables() {
  try {
    await db(`CREATE TABLE IF NOT EXISTS durka_players (
      username_low TEXT PRIMARY KEY,
      username     TEXT NOT NULL,
      points       INT NOT NULL DEFAULT 0,
      tournaments  INT NOT NULL DEFAULT 0,
      updated_at   BIGINT NOT NULL
    )`);
    await db(`CREATE INDEX IF NOT EXISTS idx_durka_players_points ON durka_players(points DESC)`);

    await db(`CREATE TABLE IF NOT EXISTS durka_tournaments (
      id           TEXT PRIMARY KEY,
      name         TEXT,
      url          TEXT,
      players      INT NOT NULL DEFAULT 0,
      added_by     TEXT,
      created_at   BIGINT NOT NULL
    )`);

    await db(`CREATE TABLE IF NOT EXISTS durka_tournament_results (
      tournament_id TEXT NOT NULL,
      username_low  TEXT NOT NULL,
      username      TEXT NOT NULL,
      points        INT NOT NULL DEFAULT 0,
      rank          INT,
      PRIMARY KEY (tournament_id, username_low)
    )`);
    await db(`CREATE INDEX IF NOT EXISTS idx_durka_results_tournament ON durka_tournament_results(tournament_id)`);

    console.log('[Durka] Таблицы инициализированы');
  } catch(e) { console.error('[Durka] init error:', e.message); }
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
  // Безопасность (issue L1): сравнение ключа — constant-time, плюс ключ
  // проверяется против заголовка, который клиент контролирует целиком.
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

// Забаненный аккаунт отсекается на ЛЮБОМ защищённом роуте (раньше его JWT
// продолжал работать до истечения срока: можно было создавать турниры,
// писать в клубные чаты и т.п.). Исключения — то, что забаненному нужно или
// что намеренно «теневое»: свой профиль, апелляции и комментарии дневника
// (они публикуются как обычно, но видит их только автор — см. moderation.js).
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
    // БАГ (исправлен): при удалённом/несуществующем аккаунте (!u) запрос
    // проходил дальше как «авторизованный» — JWT жил до 7 дней после удаления.
    // Теперь — явный 401.
    if (!u) return res.status(401).json({ error: 'Аккаунт не найден' });
    if (u.banned) {
      const p = String(req.originalUrl || req.url || '').split('?')[0];
      if (!BANNED_ALLOWED_PATHS.some(rx => rx.test(p))) {
        return res.status(403).json({ error: 'Аккаунт заблокирован' + (u.banReason ? ': ' + u.banReason : '') });
      }
    }
  } catch (e) { /* БД недоступна — не блокируем, чтобы не уронить сайт */ }
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
// POST /api/admin/role (issue #27).
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


// Инфо о командах межклубного турнира (id/название/число участников клуба) —
// нужно фронту для выбора команды и отображения турнирной сетки/составов.
function getInterclubTeamsInfo(t) {
  if (!t.isInterclub) return undefined;
  return (t.teamIds || [])
    .map(id => clubs.find(c => c.id === id))
    .filter(Boolean)
    .map(c => ({ id: c.id, name: c.name, memberCount: c.memberCount || (c.members || []).length }));
}


// Командный зачёт межклубного турнира: суммируем очки/результаты всех игроков
// каждой команды среди участников турнира (бан по читерству — не учитываем).
function computeTeamStandings(t) {
  if (!t.isInterclub) return undefined;
  const byTeam = new Map();
  for (const id of (t.teamIds || [])) {
    const club = clubs.find(c => c.id === id);
    byTeam.set(id, { teamId: id, teamName: club ? club.name : id, score: 0, wins: 0, losses: 0, draws: 0, gamesPlayed: 0, players: 0 });
  }
  for (const p of (t.participants || [])) {
    if (p.anticheatBanned || !p.teamId || !byTeam.has(p.teamId)) continue;
    const s = byTeam.get(p.teamId);
    s.score += p.score || 0;
    s.wins += p.wins || 0;
    s.losses += p.losses || 0;
    s.draws += p.draws || 0;
    s.gamesPlayed += p.gamesPlayed || 0;
    s.players += 1;
  }
  return [...byTeam.values()].sort((a, b) => b.score - a.score || b.wins - a.wins);
}


function sanitizeTournament(t) {
  const sorted = [...(t.participants || [])].filter(p => !p.anticheatBanned).sort((a, b) => b.score - a.score || b.wins - a.wins);
  return { ...t, participants: sorted, blacklist: undefined, status: getTournamentStatus(t, Date.now()), createdByIsAdmin: usersCache.get((t.createdBy || '').toLowerCase())?.role === 'admin', teams: getInterclubTeamsInfo(t), teamStandings: computeTeamStandings(t) };
}


function getTournamentStatus(t, now) {
  if (now < t.startsAt) return 'upcoming';
  if (now < t.endsAt)   return 'active';
  return 'finished';
}


function verifyToken(t) { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } }


// ── Часы партии — источник истины ТОЛЬКО сервер ────────────────
// Раньше флаг (истечение времени) определял клиентский JS-таймер,
// который просто присылал game_over с готовым результатом — это
// легко подделать. Теперь сервер сам считает оставшееся время по
// game.lastMoveAt и не доверяет клиентским заявлениям о таймауте.
function liveClock(game, now) {
  let { whiteTime, blackTime } = game;
  if (game.lastMoveAt != null && whiteTime !== undefined) {
    const elapsed = (now - game.lastMoveAt) / 1000;
    if (game.turn === 'white') whiteTime = Math.max(0, whiteTime - elapsed);
    else                       blackTime = Math.max(0, blackTime - elapsed);
  }
  return { whiteTime, blackTime };
}


// Партия считается "реально сыгранной" для статистики (/api/stats) и
// профиля (gamesPlayed/wins/losses/draws/рейтинг) только если сделан
// хотя бы 1 полный ход — то есть сходили и белые, и чёрные (минимум
// 2 полухода в game.moves). Иначе, например, когда игрок вышел до
// ответного хода соперника, партия не должна засорять статистику.
function hasFullMove(game) {
  return Array.isArray(game.moves) && game.moves.length >= 2;
}


async function endGameAuthoritative(gameId, game, result, reason) {
  // Защита от повторного входа: гонка тика часов (раз в секунду) и ручного
  // game_over/resign одного из игроков могла завершить партию дважды.
  if (game._finishing) return;
  game._finishing = true;
  if (!activeGames.has(gameId) && !tournamentGames.has(gameId)) return; // уже завершена
  activeGames.delete(gameId);
  tournamentGames.delete(gameId);
  const isTournament = !!game.tournamentId;
  if (isTournament) {
    const t = tournaments.find(t => t.id === game.tournamentId);
    if (t) await finishTournamentGame(t, game, result, reason);
  } else if (hasFullMove(game)) {
    await recordGame(game, result, reason);
    await updateStats(game.white, game.black, result, game.rated !== false);
  }
  const payload = { gameId, result, reason, white: game.white, black: game.black };
  [findSocketByUsername(game.white), findSocketByUsername(game.black)].forEach(s => s?.emit('game_ended', payload));
}


// Каждую секунду проверяем все активные партии на падение флага —
// независимо от того, что показывает (или не показывает) клиент.
setInterval(() => {
  const now = Date.now();
  for (const [gameId, game] of activeGames.entries()) {
    if (game.whiteTime === undefined || game.blackTime === undefined) continue;
    const { whiteTime, blackTime } = liveClock(game, now);
    if (whiteTime <= 0) endGameAuthoritative(gameId, game, 'black', 'timeout').catch(e => console.error('[Clock]', e.message));
    else if (blackTime <= 0) endGameAuthoritative(gameId, game, 'white', 'timeout').catch(e => console.error('[Clock]', e.message));
  }
}, 1000);


function findSocketByUsername(username) {
  // Было: линейный перебор всей карты sessions на каждый вызов (O(n)).
  // Стало: прямой доступ по индексу usernameToSocketId (O(1)).
  //
  // Multi-socket: у юзера может быть несколько легитимных сокетов одновременно
  // (основной app.js + DM-сокет header.js). Возвращаем fanout-эмиттер: emit()
  // доставляет событие ВСЕМ сокетам юзера, disconnect() отключает все. Все
  // существующие вызовы вида s?.emit(...) / if (sock) sock.emit(...) работают
  // без изменений — но больше не зависят от того, какой из сокетов юзера
  // «победил» в гонке регистрации (раньше события молча терялись — issue #52).
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
// Раньше данные жалоб/античита рассылались через ad-hoc циклы —
// вынесено в одну функцию, чтобы гарантировать: эти сокет-события
// НИКОГДА не попадают обычным пользователям (утечка в Network).
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


async function recordGame(game, result, reason) {
  // Товарищеские (нерейтинговые) партии тоже сохраняются в историю — просто
  // без пересчёта рейтинга (см. updateStats и её вызовы ниже). Турнирные
  // партии всегда рейтинговые.
  const rated = game.tournamentId ? true : (game.rated !== false);
  await db(`
    INSERT INTO games (id, white, black, result, reason, moves, time_control, ended_at, berserk, accuracy, tournament_id, rated)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (id) DO NOTHING
  `, [game.id, game.white, game.black, result, reason,
      JSON.stringify(game.moves || []), game.timeControl || null,
      Date.now(), JSON.stringify(game.berserk || null),
      JSON.stringify(game.accuracy || null), game.tournamentId || null, rated]);
}


const RATING_SERVICE_URL = process.env.RATING_SERVICE_URL || 'http://127.0.0.1:8081/api/rating/calculate';

// Считает новые рейтинги через Go-сервис. Если он недоступен, падаем
// на прежнюю JS-формулу, чтобы партия не зависла из-за отказа Go.
async function calcNewRatings(wRating, bRating, result) {
  try {
    const res = await fetch(RATING_SERVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ whiteRating: wRating, blackRating: bRating, result }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return { white: data.whiteRating, black: data.blackRating };
  } catch (e) {
    console.error('[Rating] Go-сервис недоступен, считаю на JS:', e.message);
    const K = 32;
    const expW = 1 / (1 + Math.pow(10, (bRating - wRating) / 400));
    const sW = result === 'white' ? 1 : result === 'black' ? 0 : 0.5;
    return {
      white: Math.round(wRating + K * (sW - expW)),
      black: Math.round(bRating + K * ((1 - sW) - (1 - expW))),
    };
  }
}


async function updateStats(white, black, result, rated = true) {
  // Гонка данных (БАГ исправлен): раньше статистика обновлялась read-modify-write
  // по объектам из кэша + saveUser (whole-row upsert). Два одновременных финала
  // партий с общим игроком теряли инкременты и/или считали Elo от промежуточных
  // значений. Теперь: транзакция + SELECT ... FOR UPDATE блокирует строки обоих
  // игроков, инкременты выполняются одним атомарным UPDATE, и кэш синхронизируется
  // из фактических значений БД (шаблон — как в квестах /api/quests/complete).
  const wLow = white.toLowerCase(), bLow = black.toLowerCase();
  if (wLow === bLow) return; // сам с собой — не бывает, но защита от деления на ноль в Elo
  try {
    // Стабильность транзакции (P1): сетевой вызов calcNewRatings (fetch к
    // Go-сервису, таймаут 2с) вынесен ДО withTransaction. Раньше он выполнялся
    // внутри открытой транзакции при удержании FOR UPDATE на строках ОБОИХ
    // игроков — недоступный/медленный Go-сервис растягивал блокировку на
    // секунды, стопоря все партии с участием этих игроков и провоцируя
    // каскадные таймауты. Читаем рейтинги отдельным запросом, считаем Elo,
    // и только потом открываем короткую атомарную транзакцию.
    let newRatingW, newRatingB;
    if (rated) {
      const curUsers = await db(
        `SELECT username_low, rating FROM users WHERE username_low IN ($1, $2)`,
        [wLow, bLow]
      );
      const rowW0 = curUsers.rows.find(x => x.username_low === wLow);
      const rowB0 = curUsers.rows.find(x => x.username_low === bLow);
      if (!rowW0 || !rowB0) return;
      const nr = await calcNewRatings(rowW0.rating, rowB0.rating, result);
      newRatingW = Math.max(100, nr.white);
      newRatingB = Math.max(100, nr.black);
    }

    const finalW = await withTransaction(async (client) => {
      const r = await client.query(
        `SELECT id, username, username_low, rating, games_played, wins, losses, draws
           FROM users WHERE username_low IN ($1, $2) ORDER BY username_low FOR UPDATE`,
        [wLow, bLow]
      );
      if (r.rows.length < 2) return null;
      const rowW = r.rows.find(x => x.username_low === wLow);
      const rowB = r.rows.find(x => x.username_low === bLow);
      if (!rowW || !rowB) return null;
      const incW = result === 'white' ? 'games_played = games_played + 1, wins = wins + 1' : result === 'black' ? 'games_played = games_played + 1, losses = losses + 1' : 'games_played = games_played + 1, draws = draws + 1';
      const incB = result === 'white' ? 'games_played = games_played + 1, losses = losses + 1' : result === 'black' ? 'games_played = games_played + 1, wins = wins + 1' : 'games_played = games_played + 1, draws = draws + 1';
      const upd = await client.query(
        `UPDATE users SET ${rated ? 'rating = $2,' : ''} ${incW}
           WHERE username_low = $1 RETURNING rating, games_played, wins, losses, draws`,
        rated ? [wLow, newRatingW] : [wLow]
      );
      await client.query(
        `UPDATE users SET ${rated ? 'rating = $2,' : ''} ${incB}
           WHERE username_low = $1 RETURNING rating, games_played, wins, losses, draws`,
        rated ? [bLow, newRatingB] : [bLow]
      );
      return { wRow: upd.rows[0], ratingW: newRatingW, ratingB: newRatingB };
    });
    // Синхронизируем кэш из фактических значений БД (а не из локальных объектов)
    if (finalW && finalW.wRow) {
      const w = await getUser(wLow);
      const b = await getUser(bLow);
      if (w) { Object.assign(w, { rating: finalW.wRow.rating, gamesPlayed: finalW.wRow.games_played, wins: finalW.wRow.wins, losses: finalW.wRow.losses, draws: finalW.wRow.draws }); cacheUser(w); }
      if (b) { const r2 = await db('SELECT rating, games_played, wins, losses, draws FROM users WHERE username_low = $1', [bLow]);
        if (r2.rows[0]) Object.assign(b, { rating: r2.rows[0].rating, gamesPlayed: r2.rows[0].games_played, wins: r2.rows[0].wins, losses: r2.rows[0].losses, draws: r2.rows[0].draws }); cacheUser(b); }
    }
  } catch (e) {
    console.error('[updateStats]', e.message);
  }
}


// Грейс-период после завершения партии: даже если пара уже готова,
// игрока не спариваем ещё REMATCH_GRACE_PERIOD мс — чтобы он успел
// вернуться на страницу турнира и, если хочет, нажать "Пауза" ДО того,
// как придёт game_start и клиент редиректнет его в новую партию.
// Отменяется мгновенно, если игрок сам нажал "Играть" (см. tournament_seek/tournament_waiting).
const REMATCH_GRACE_PERIOD = 8000;


function tryPairTournamentPlayers(tournament) {
  const now = Date.now();
  if (getTournamentStatus(tournament, now) !== 'active') return;
  const waiting = tournament.participants.filter(p =>
    p.waiting && !p.left && !p.currentGameId && !p.anticheatBanned &&
    (!p.nextEligibleAt || now >= p.nextEligibleAt)
  );
  if (waiting.length < 2) return;

  const games = tournament.games;

  // Считаем сколько раз каждая пара уже играла друг с другом
  function gamesPlayed(a, b) {
    return games.filter(g =>
      (g.white === a && g.black === b) || (g.white === b && g.black === a)
    ).length;
  }

  // Межклубный турнир: игроки одной команды (клуба) друг с другом не спариваются.
  function sameTeam(pa, pb) {
    return tournament.isInterclub && pa.teamId && pb.teamId && pa.teamId === pb.teamId;
  }

  // Кто был последним соперником игрока
  function lastOpponent(username) {
    for (let k = games.length - 1; k >= 0; k--) {
      const g = games[k];
      if (g.white === username) return g.black;
      if (g.black === username) return g.white;
    }
    return null;
  }

  // Сортируем: кто дольше ждёт — тот первым получает партию
  waiting.sort((a, b) => (a.lastGameAt || 0) - (b.lastGameAt || 0));

  const paired = new Set();

  for (let i = 0; i < waiting.length; i++) {
    if (paired.has(waiting[i].username)) continue;
    const pi = waiting[i];
    const piLastOpp = lastOpponent(pi.username);

    // Выбираем лучшего соперника:
    // 1. Меньше всего сыграно партий вместе (равенство)
    // 2. Не был последним соперником (чередование)
    // 3. Кто дольше ждёт (справедливость)
    let bestJ = -1;
    let bestScore = Infinity;

    for (let j = i + 1; j < waiting.length; j++) {
      if (paired.has(waiting[j].username)) continue;
      const pj = waiting[j];
      if (sameTeam(pi, pj)) continue; // одноклубники не играют друг с другом
      const played = gamesPlayed(pi.username, pj.username);
      const isLastOpp = pj.username === piLastOpp ? 1 : 0;
      // Меньше score — лучше пара
      const score = played * 10 + isLastOpp * 1000;
      if (score < bestScore) {
        bestScore = score;
        bestJ = j;
      }
    }

    if (bestJ === -1) continue; // bye — сыграет следующим

    paired.add(pi.username);
    paired.add(waiting[bestJ].username);
    pi.waiting = false;
    waiting[bestJ].waiting = false;
    startTournamentGame(tournament, pi, waiting[bestJ]);
  }
  // При нечётном числе один игрок остаётся в waiting (bye) и получит партию следующим
}


const FIRST_MOVE_TIMEOUT = 20 * 1000;
 // время на первый ход — общее для белых и чёрных

function startTournamentGame(tournament, p1, p2) {
  const gameId = uuidv4();
  const p1Last = [...tournament.games].reverse().find(g => g.white === p1.username || g.black === p1.username);
  let white, black;
  if (!p1Last || p1Last.black === p1.username) { white = p1.username; black = p2.username; }
  else { white = p2.username; black = p1.username; }
  const wR = usersCache.get(white.toLowerCase())?.rating ?? '?';
  const bR = usersCache.get(black.toLowerCase())?.rating ?? '?';
  const [tcBaseT, tcIncTStr] = tournament.timeControl.split('+');
  const tcIncT = Number(tcIncTStr);
  const tcSecT = tcBaseT && tcBaseT.endsWith('s') ? (Number(tcBaseT.slice(0, -1)) || 15) : (Number(tcBaseT) || 10) * 60;
  const now = Date.now();
  const game = {
    id: gameId, tournamentId: tournament.id, white, black,
    turn: 'white', moves: [], createdAt: now, lastActivity: now,
    timeControl: tournament.timeControl, whiteTime: tcSecT, blackTime: tcSecT,
    tcIncrement: tcIncT || 0, lastMoveAt: now,
    berserk: { white: false, black: false }, moveCounts: { white: 0, black: 0 },
    _board: serverChess.startBoard(),
    firstMoveDeadline: now + FIRST_MOVE_TIMEOUT,
    isInterclub: !!tournament.isInterclub,
  };
  activeGames.set(gameId, game);
  tournamentGames.set(gameId, game);
  p1.currentGameId = gameId; p2.currentGameId = gameId;
  const payload = (color, opp, oppRating) => ({
    gameId, color, opponent: opp, opponentRating: oppRating,
    timeControl: tournament.timeControl,
    tournamentId: tournament.id, tournamentName: tournament.name,
    isInterclub: !!tournament.isInterclub,
    firstMoveDeadline: game.firstMoveDeadline,
    // Синхронизация часов (P1) — см. startGame ниже.
    serverAt: now, lastMoveAt: game.lastMoveAt, whiteTime: game.whiteTime, blackTime: game.blackTime,
  });
  const ws = findSocketByUsername(white);
  const bs = findSocketByUsername(black);
  if (ws) ws.emit('game_start', payload('white', black, bR));
  if (bs) bs.emit('game_start', payload('black', white, wR));
  saveTournament(tournament).catch(() => {});
  io.to(`tournament_${tournament.id}`).emit('tournament_update', sanitizeTournament(tournament));
}


async function finishTournamentGame(tournament, game, result, reason) {
  // Защита от двойного завершения одной и той же турнирной партии (гонка
  // resign/timeout/game_over): без флага параллельные финалы давали двойные
  // очки, дубли в tournament.games и сломанные счётчики participants.
  if (game._tournamentFinished) return;
  game._tournamentFinished = true;
  const now = Date.now();
  const wp = tournament.participants.find(p => p.username === game.white);
  const bp = tournament.participants.find(p => p.username === game.black);
  if (wp) { wp.currentGameId = null; wp.lastGameAt = now; wp.gamesPlayed++; }
  if (bp) { bp.currentGameId = null; bp.lastGameAt = now; bp.gamesPlayed++; }
  const isInTime = now < tournament.endsAt;
  const berserkCondition = game.moveCounts?.white >= 7 && game.moveCounts?.black >= 7;
  if (isInTime && wp && bp) {
    if (result === 'white') {
      wp.wins++; bp.losses++; bp.streak = 0; bp.flame = false;
      const bonus = game.berserk?.white && berserkCondition ? 1 : 0;
      wp.score += (wp.flame ? 4 : 2) + bonus; wp.streak++; wp.flame = wp.streak >= 2;
    } else if (result === 'black') {
      bp.wins++; wp.losses++; wp.streak = 0; wp.flame = false;
      const bonus = game.berserk?.black && berserkCondition ? 1 : 0;
      bp.score += (bp.flame ? 4 : 2) + bonus; bp.streak++; bp.flame = bp.streak >= 2;
    } else {
      wp.score += wp.flame ? 2 : 1; bp.score += bp.flame ? 2 : 1;
      wp.draws++; bp.draws++; wp.streak = 0; bp.streak = 0; wp.flame = false; bp.flame = false;
    }
  }
  tournament.games.push({ id: game.id, white: game.white, black: game.black, result, reason, moves: game.moves, timeControl: game.timeControl, endedAt: now, berserk: game.berserk, accuracy: game.accuracy || null });
  // В общую таблицу games и в личную статистику/профиль игрока (updateStats)
  // партия попадает, только если сделан хотя бы 1 полный ход — сама турнирная
  // логика (пары, счёт турнира, история встреч выше) при этом не меняется.
  if (hasFullMove(game)) {
    await recordGame(game, result, reason);
    await updateStats(game.white, game.black, result);
  }
  // Если партия завершилась из-за неявки на первый ход — сторону, не сделавшую
  // ход (при timeout_firstmove это всегда белые, т.к. первый ход за ними),
  // не возвращаем в очередь автоматически: ставим на паузу, новую пару даём
  // только после того, как игрок сам нажмёт "Играть".
  // Просрочивший первый ход — проигравшая сторона в этой партии (result — цвет победителя)
  const afkColor = reason === 'timeout_firstmove' ? (result === 'white' ? 'black' : 'white') : null;
  // nextEligibleAt — до этого момента игрок формально "в поиске" (waiting=true,
  // баннер и кнопка "Пауза" на странице турнира уже показываются), но
  // tryPairTournamentPlayers его пока пропускает — см. REMATCH_GRACE_PERIOD выше.
  const nextEligibleAt = now + REMATCH_GRACE_PERIOD;
  if (wp && !wp.left && !wp.anticheatBanned && now < tournament.endsAt) {
    if (afkColor === 'white') { wp.waiting = false; wp.paused = true; wp.nextEligibleAt = 0; }
    else { wp.waiting = true; wp.paused = false; wp.nextEligibleAt = nextEligibleAt; }
  }
  if (bp && !bp.left && !bp.anticheatBanned && now < tournament.endsAt) {
    if (afkColor === 'black') { bp.waiting = false; bp.paused = true; bp.nextEligibleAt = 0; }
    else { bp.waiting = true; bp.paused = false; bp.nextEligibleAt = nextEligibleAt; }
  }
  await saveTournament(tournament);
  io.to(`tournament_${tournament.id}`).emit('tournament_update', sanitizeTournament(tournament));
  // Первая попытка — заспарит других игроков, у которых грейс-период уже истёк
  // или которых не касался (например "bye"-игрок, ждавший своей очереди).
  setTimeout(() => tryPairTournamentPlayers(tournament), 500);
  // Вторая попытка — уже после того, как грейс-период для только что
  // освободившихся игроков истечёт (если они сами не поставили паузу).
  setTimeout(() => tryPairTournamentPlayers(tournament), REMATCH_GRACE_PERIOD + 500);
}


// Античит: пустая заглушка checkAnticheat() и мёртвые константы
// ANTICHEAT_THRESHOLD / ANTICHEAT_STREAK_BAN УДАЛЕНЫ (мёртвый код).
// Живые серверные сигналы: timer-based детект движка в make_move
// (_acSuspect → alert админам) и ручные жалобы/модерация. Реабилитационная
// логика anticheatBan() остаётся доступной для серверных источников сигнала.
function anticheatBan(tournament, username) {
  const p = tournament.participants.find(p => p.username === username);
  if (!p || p.anticheatBanned) return;
  p.anticheatBanned = true; p.waiting = false; p.left = true; p.currentGameId = null;
  let compensated = 0;
  for (const g of tournament.games) {
    const oppName = g.white === username ? g.black : g.black === username ? g.white : null;
    if (!oppName) continue;
    // Помечаем партию как аннулированную
    g.anticheatBanned = true;
    const opp = tournament.participants.find(p => p.username === oppName && !p.anticheatBanned);
    if (!opp) continue;
    const bannedWon = (g.white === username && g.result === 'white') || (g.black === username && g.result === 'black');
    const bannedDraw = g.result === 'draw';
    if (bannedWon) {
      opp.score += 2; opp.wins++; opp.losses = Math.max(0, opp.losses - 1);
      compensated++;
      const s = findSocketByUsername(oppName);
      if (s) s.emit('anticheat_compensation', { message: `${username} забанен за читы. Ваше поражение аннулировано (+2 очка)!`, tournamentId: tournament.id });
    } else if (bannedDraw) {
      // За ничью сопернику дают +1 очко компенсации
      opp.score = Math.max(0, opp.score - 1); // убираем очко ничьей
      opp.draws = Math.max(0, opp.draws - 1);
      opp.wins++; opp.score += 2; // засчитываем победу
      compensated++;
      const s = findSocketByUsername(oppName);
      if (s) s.emit('anticheat_compensation', { message: `${username} забанен за читы. Ваша ничья переведена в победу (+1 очко)!`, tournamentId: tournament.id });
    }
  }
  io.to(`tournament_${tournament.id}`).emit('anticheat_ban', { username, tournamentId: tournament.id, tournamentName: tournament.name, message: `⚠️ ${username} забанен за использование компьютерной помощи.` });
  const sock = findSocketByUsername(username);
  if (sock) sock.emit('tournament_banned', { message: 'Вы заблокированы в этом турнире за использование компьютерной помощи.' });
  saveTournament(tournament).catch(() => {});
}


function startGame(acceptorSocket, challenge) {
  const gameId = uuidv4();
  let white, black;
  if (challenge.color === 'white')      { white = challenge.from; black = acceptorSocket.username; }
  else if (challenge.color === 'black') { white = acceptorSocket.username; black = challenge.from; }
  else { if (Math.random() > 0.5) { white = challenge.from; black = acceptorSocket.username; } else { white = acceptorSocket.username; black = challenge.from; } }
  const [tcBase, tcIncStr] = challenge.timeControl.split('+');
  const tcInc = Number(tcIncStr);
  const tcSec = tcBase && tcBase.endsWith('s') ? (Number(tcBase.slice(0, -1)) || 15) : (Number(tcBase) || 10) * 60;
  const gameNow = Date.now();
  // Товарищеская партия: challenge.rated === false явно выставляется при
  // создании вызова (post_challenge / challenge_user). По умолчанию — рейтинговая.
  const rated = challenge.rated !== false;
  const game = { id: gameId, white, black, turn: 'white', moves: [], createdAt: gameNow, lastActivity: gameNow, timeControl: challenge.timeControl, whiteTime: tcSec, blackTime: tcSec, tcIncrement: tcInc || 0, lastMoveAt: gameNow, _board: serverChess.startBoard(), rated };
  activeGames.set(gameId, game);
  const wR = usersCache.get(white.toLowerCase())?.rating ?? '?';
  const bR = usersCache.get(black.toLowerCase())?.rating ?? '?';
  const ws = findSocketByUsername(white); const bs = findSocketByUsername(black);
  // Синхронизация часов (P1): отдаём клиенту момент начала отсчёта
  // (lastMoveAt = момент создания партии) и серверное "сейчас", чтобы
  // клиентский таймер белых шёл синхронно с серверным liveClock с самой
  // первой секунды, а не начинался после первого хода / 10с грейса.
  if (ws) ws.emit('game_start', { gameId, color: 'white', opponent: black, opponentRating: bR, timeControl: game.timeControl, rated, serverAt: Date.now(), lastMoveAt: game.lastMoveAt, whiteTime: game.whiteTime, blackTime: game.blackTime });
  if (bs) bs.emit('game_start', { gameId, color: 'black', opponent: white, opponentRating: wR, timeControl: game.timeControl, rated, serverAt: Date.now(), lastMoveAt: game.lastMoveAt, whiteTime: game.whiteTime, blackTime: game.blackTime });
}


setInterval(async () => {
  const now = Date.now();
  for (const t of tournaments) {
    const status = getTournamentStatus(t, now);
    if (status === 'active') {
      // При первом тике активного турнира — ставим всех незанятых участников в waiting
      if (!t._startNotified) {
        t._startNotified = true;
        let anyChanged = false;
        for (const p of t.participants) {
          if (!p.left && !p.anticheatBanned && !p.currentGameId && !p.waiting && !p.paused) {
            p.waiting = true;
            anyChanged = true;
          }
        }
        if (anyChanged) {
          await saveTournament(t);
          io.to(`tournament_${t.id}`).emit('tournament_update', sanitizeTournament(t));
          // Уведомляем участников о старте
          for (const p of t.participants) {
            if (!p.left && !p.anticheatBanned) {
              const s = findSocketByUsername(p.username);
              if (s) s.emit('tournament_started', { tournamentId: t.id, name: t.name });
            }
          }
        }
      }

      for (const [gameId, game] of tournamentGames.entries()) {
        if (game.tournamentId !== t.id) continue;
        if (game.firstMoveDeadline && now > game.firstMoveDeadline) {
          if (game.moves.length === 0) {
            // Белые не сделали первый ход — поражение белых.
            // Гонка (БАГ исправлен): из карт удаляем СИНХРОННО ДО await — иначе
            // параллельный resign/timeout успевает завершить партию второй раз
            // (двойные очки турнира/дубли в tournament.games).
            console.log(`[Tournament] Первый ход просрочен: ${game.white} (белые) в игре ${gameId}`);
            tournamentGames.delete(gameId);
            activeGames.delete(gameId);
            const ws = findSocketByUsername(game.white);
            const bs = findSocketByUsername(game.black);
            const payload = { gameId, result: 'black', reason: 'timeout_firstmove' };
            if (ws) ws.emit('game_ended', payload);
            if (bs) bs.emit('game_ended', payload);
            await finishTournamentGame(t, game, 'black', 'timeout_firstmove');
          } else if (game.moves.length === 1) {
            // Белые сходили, чёрные не сделали свой первый ход — поражение чёрных
            console.log(`[Tournament] Первый ход просрочен: ${game.black} (чёрные) в игре ${gameId}`);
            tournamentGames.delete(gameId);
            activeGames.delete(gameId);
            const ws = findSocketByUsername(game.white);
            const bs = findSocketByUsername(game.black);
            const payload = { gameId, result: 'white', reason: 'timeout_firstmove' };
            if (ws) ws.emit('game_ended', payload);
            if (bs) bs.emit('game_ended', payload);
            await finishTournamentGame(t, game, 'white', 'timeout_firstmove');
          }
        }
      }
      tryPairTournamentPlayers(t);
    }
    if (status === 'finished' && !t.winner && t.participants.length > 0) {
      const sorted = [...t.participants].filter(p => !p.anticheatBanned).sort((a, b) => b.score - a.score || b.wins - a.wins);
      t.winner = sorted[0]?.username || null;
      await saveTournament(t);
      io.to(`tournament_${t.id}`).emit('tournament_finished', { winner: t.winner, tournament: t });
    }
  }
}, 3000);


setInterval(async () => {
  const twoYearsAgo = Date.now() - 2 * 365 * 24 * 60 * 60 * 1000;
  for (let i = tournaments.length - 1; i >= 0; i--) {
    const t = tournaments[i];
    if (t.endsAt && t.endsAt < twoYearsAgo) { tournaments.splice(i, 1); await deleteTournamentFromDB(t.id); }
  }
}, 24 * 60 * 60 * 1000);


const serverChess = (() => {
  // ── Шахматные правила НА chess.js ─────────────────────────────
  // Раньше здесь был самописный движок (~150 строк: генерация ходов,
  // шахи, рокировки, взятие на проходе). В нём был баг "призрачной
  // ладьи": при взятии ладьи на её начальном поле право рокировки
  // не снималось, и рокировка становилась возможной без ладьи.
  // Теперь ВСЯ логика правил — в библиотеке chess.js, этот модуль
  // лишь адаптирует её к внутреннему формату партии:
  //   board   = { squares: Array(64) из null | [ТИП,'w'|'b'],
  //               turn: 'w'|'b', castling: {wK,wQ,bK,bQ}, epSquare: idx|-1 }
  //   move    = { from: 0..63, to: 0..63, promotion?: 'q'|'Q', ep?, castle? }
  const { Chess } = require('chess.js');

  function indexToSquare(idx) {
    return String.fromCharCode(97 + (idx % 8)) + (Math.floor(idx / 8) + 1);
  }
  function squareToIndex(sq) {
    return (sq.charCodeAt(1) - 49) * 8 + (sq.charCodeAt(0) - 97);
  }

  // FEN -> board-объект формата партии
  function boardFromFen(fen) {
    const c = new Chess(fen);
    const parts = fen.trim().split(' ');
    const rows = c.board(); // 8x8, от 8-го ранга к 1-му
    const squares = Array(64).fill(null);
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = rows[r][f];
        if (p) squares[(7 - r) * 8 + f] = [p.type.toUpperCase(), p.color];
      }
    }
    const castling = { wK: false, wQ: false, bK: false, bQ: false };
    if (parts[2] && parts[2] !== '-') {
      castling.wK = parts[2].includes('K');
      castling.wQ = parts[2].includes('Q');
      castling.bK = parts[2].includes('k');
      castling.bQ = parts[2].includes('q');
    }
    return {
      squares,
      turn: c.turn(),
      castling,
      epSquare: parts[3] && parts[3] !== '-' ? squareToIndex(parts[3]) : -1,
      _fen: c.fen(),
    };
  }

  // board-объект -> FEN (фолбэк для объектов без _fen)
  function fenFromBoard(b) {
    let placement = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = b.squares[r * 8 + f];
        if (!p) { empty++; continue; }
        if (empty) { placement += empty; empty = 0; }
        placement += p[1] === 'w' ? p[0] : p[0].toLowerCase();
      }
      if (empty) placement += empty;
      if (r > 0) placement += '/';
    }
    let cas = '';
    if (b.castling) {
      if (b.castling.wK) cas += 'K';
      if (b.castling.wQ) cas += 'Q';
      if (b.castling.bK) cas += 'k';
      if (b.castling.bQ) cas += 'q';
    }
    return placement + ' ' + (b.turn || 'w') + ' ' + (cas || '-') + ' '
      + (b.epSquare >= 0 ? indexToSquare(b.epSquare) : '-') + ' 0 1';
  }

  function makeChess(b) {
    try { return new Chess(b._fen || fenFromBoard(b)); } catch (e) { return null; }
  }

  function cloneBoard(b) {
    return { squares: [...b.squares], turn: b.turn, castling: { ...b.castling }, epSquare: b.epSquare, _fen: b._fen };
  }

  function startBoard() {
    return boardFromFen(new Chess().fen());
  }

  // Поиск verbose-хода chess.js по формату партии
  function matchVerboseMove(c, b, move) {
    const fromSq = indexToSquare(move.from);
    const toSq = indexToSquare(move.to);
    const all = c.moves({ square: fromSq, verbose: true }).filter(m => m.to === toSq);
    if (!all.length) return null;
    if (move.promotion) {
      const promo = String(move.promotion).toLowerCase();
      return all.find(m => m.promotion === promo) || null;
    }
    // Превращение без указания фигуры — ферзь (как и раньше)
    return all.find(m => m.promotion === 'q') || all[0];
  }

  function verboseToGameMove(v) {
    return {
      from: squareToIndex(v.from),
      to: squareToIndex(v.to),
      promotion: v.promotion ? v.promotion.toUpperCase() : undefined,
      castle: v.flags.includes('k') ? 'K' : v.flags.includes('q') ? 'Q' : undefined,
      ep: v.flags.includes('e') || undefined,
    };
  }

  function isLegalMove(board, move) {
    if (!move || !Number.isInteger(move.from) || !Number.isInteger(move.to)) return false;
    const piece = board.squares[move.from];
    if (!piece || piece[1] !== board.turn) return false;
    const c = makeChess(board);
    if (!c) return false;
    return matchVerboseMove(c, board, move) != null;
  }

  // Возвращает нормализованный ход (с флагами castle/ep/promotion)
  // либо исходный move, если совпадение не нашлось (как раньше).
  function findMove(board, move) {
    const c = makeChess(board);
    if (!c) return move;
    const v = matchVerboseMove(c, board, move);
    return v ? verboseToGameMove(v) : move;
  }

  function applyMove(board, move) {
    const c = makeChess(board);
    if (!c) return cloneBoard(board);
    const v = matchVerboseMove(c, board, move);
    if (!v) return cloneBoard(board);
    c.move({ from: indexToSquare(move.from), to: indexToSquare(move.to), promotion: v.promotion || undefined });
    return boardFromFen(c.fen());
  }

  // Реплей партии с нуля средствами chess.js: корректно обрабатывает
  // рокировки, взятия на проходе, превращения, счётчики полуходов.
  function replayChess(moves) {
    const c = new Chess();
    for (const move of (moves || [])) {
      try {
        const promo = move.promotion ? String(move.promotion).toLowerCase() : undefined;
        c.move({ from: indexToSquare(move.from), to: indexToSquare(move.to), promotion: promo });
      } catch (e) {
        // Пытаемся с ферзём по умолчанию (старое поведение), иначе — прерываем
        try {
          c.move({ from: indexToSquare(move.from), to: indexToSquare(move.to), promotion: 'q' });
        } catch (e2) {
          console.warn('[serverChess] replay: ход не применился:', move && move.from, '->', move && move.to, e2.message);
          break;
        }
      }
    }
    return c;
  }

  function rebuildBoard(moves) {
    return boardFromFen(replayChess(moves).fen());
  }

  function hasAnyLegalMove(board, color) {
    const c = makeChess(board);
    if (!c) return false;
    if (color === board.turn) return c.moves().length > 0;
    // Редкий случай: спрашивают про цвет, который сейчас не ходит —
    // пересобираем позицию с нужной очередью хода.
    try {
      const fen = (board._fen || fenFromBoard(board)).split(' ');
      fen[1] = color;
      return new Chess(fen.join(' ')).moves().length > 0;
    } catch (e) { return false; }
  }

  function isCheckmate(board) {
    const c = makeChess(board);
    return c ? c.isCheckmate() : false;
  }

  function isStalemate(board) {
    const c = makeChess(board);
    return c ? c.isStalemate() : false;
  }

  // Аргумент — массив squares (как в старом API: isInsufficientMaterial(board.squares))
  function isInsufficientMaterial(squares) {
    const probe = (turn) => {
      try {
        const fen = fenFromBoard({ squares, turn, castling: { wK: false, wQ: false, bK: false, bQ: false }, epSquare: -1 });
        return new Chess(fen).isInsufficientMaterial();
      } catch (e) { return null; }
    };
    const r = probe('w');
    if (r !== null) return r;
    const r2 = probe('b');
    if (r2 !== null) return r2;
    // Совсем экзотический случай (нет королей) — позиция невалидна,
    // недостаток материала не заявляем.
    return false;
  }

  // Троекратное повторение и правило 50 ходов — по полной истории ходов:
  // chess.js сам ведёт счёт повторений позиций и счётчик полуходов.
  function isThreefoldRepetition(moves) {
    try { return replayChess(moves).isThreefoldRepetition(); } catch (e) { return false; }
  }

  function isFiftyMoveRule(moves) {
    try { return replayChess(moves).isDrawByFiftyMoves(); } catch (e) { return false; }
  }

  return { startBoard, isLegalMove, applyMove, cloneBoard, rebuildBoard, findMove, isCheckmate, isStalemate, hasAnyLegalMove, isInsufficientMaterial, isThreefoldRepetition, isFiftyMoveRule };
})();


const limiterSocketConnect = new RateLimiter(60_000, 200);


async function main() {
  // Fail-fast (issue H5): JWT_SECRET — единственный ключ идентичности на сайте
  // (payload содержит username, роль берётся из БД по нему). Без проверки сервер
  // молча стартовал с дефолтным/коротким секретом — это полный impersonation
  // любого пользователя/админа через подделку токена. Теперь без сильного секрета
  // сервер не запускается. Генерация: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  if (!JWT_SECRET || typeof JWT_SECRET !== 'string' || JWT_SECRET.length < 32 || /change_me|changeme|secret$/i.test(JWT_SECRET)) {
    console.error('❌ FATAL: JWT_SECRET не задан/слишком короткий/дефолтный. Сгенерируйте сильный секрет и укажите его в .env:');
    console.error("   node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"");
    process.exit(1);
  }

  console.log('🐘 Подключение к PostgreSQL...');
  await pool.query('SELECT 1');
  console.log('✅ PostgreSQL подключён');

  await loadBansFromDB();
  await initPuzzleTables();
  await initQuestTables();
  await initDurkaTables();
  await initClubChatTable();
  await initTournamentChatTable();
  // Клубные турниры: привязка турнира к клубу + флаг «только для участников клуба»
  await db(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS club_id TEXT`);
  await db(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS club_only BOOLEAN DEFAULT FALSE`);
  await db(`CREATE INDEX IF NOT EXISTS idx_tournaments_club_id ON tournaments(club_id)`);
  // Межклубные турниры: is_interclub — флаг, team_ids — JSON-массив id клубов-команд (макс. 175).
  await db(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS is_interclub BOOLEAN DEFAULT FALSE`);
  await db(`ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS team_ids JSONB DEFAULT '[]'`);
  await db(`CREATE INDEX IF NOT EXISTS idx_tournaments_is_interclub ON tournaments(is_interclub)`);
  // Expression-индекс под SQL-версию normForSimilarity (проверка «ник слишком
  // похож» при регистрации) — раньше на каждую регистрацию читалась вся таблица
  // users в Node (см. routes.js /api/register).
  await db(`CREATE INDEX IF NOT EXISTS idx_users_norm_username ON users (translate(regexp_replace(username_low, '[-_.]', '', 'g'), 'іаеорсхв013', 'iaepcxboie'))`);
  await db(`
    CREATE TABLE IF NOT EXISTS deleted_usernames (
      username_low TEXT PRIMARY KEY,
      deleted_at   BIGINT NOT NULL
    )
  `);
  // Описание профиля и внешние рейтинги (ФШР/FIDE)
  await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT ''`);
  await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS fshr_rating INT`);
  await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS fide_rating INT`);
  // Email/2FA полностью выведены из продукта (email нигде не используется) —
  // колонка двухфакторки больше не нужна.
  await db(`ALTER TABLE users DROP COLUMN IF EXISTS two_factor_enabled`);
  // VIP-значок: временный статус (метка времени окончания в мс), выдаётся вручную
  // из админ-панели сайт-админами (см. isVipGranter/requireVipGranter).
  await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vip_until BIGINT`);
  // Значки профиля (победитель сезона и т.п.): JSON-массив id из USER_BADGES,
  // выдаются/снимаются вручную из админ-панели.
  await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS badges JSONB DEFAULT '[]'`);
  // Теневой бан: в отличие от обычного banned (который блокирует ЛЮБОЕ
  // действие и виден самому юзеру), shadow_banned НИЧЕГО не блокирует —
  // человек продолжает пользоваться сайтом как обычно, но его сообщения
  // (публичный чат и ЛС) реально видит только он сам и админы; для всех
  // остальных они как будто не отправлялись. При этом на публичном
  // профиле остальные пользователи видят его как забаненного (см.
  // sanitizeUser), а сам он — нет.
  await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS shadow_banned BOOLEAN DEFAULT FALSE`);
  await db(`ALTER TABLE users ADD COLUMN IF NOT EXISTS shadow_ban_reason TEXT`);
  // Помечает ЛС, отправленные во время теневого бана — такие сообщения
  // хранятся (для админ-аудита), но не показываются получателю (см.
  // /api/dm/send и /api/dm/messages/:partner).
  await db(`ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS shadow_hidden BOOLEAN DEFAULT FALSE`);
  // То же самое, но для глобального чата — раньше shadow_hidden/emoji/vip
  // для сообщений публичного чата существовали только в оперативной памяти
  // (в globalChat), а не в БД. Из-за этого после pm2 restart all/перезапуска
  // процесса вся история чата теряла эти пометки: теневые сообщения
  // "рассекречивались", а vip-значки и emoji рядом с ником пропадали, пока
  // человек не написал что-то новое (см. loadChat/saveChatMsg). Сообщения,
  // отправленные ДО этой миграции, задним числом эти поля не получат —
  // взять их неоткуда, они просто не сохранялись раньше.
  await db(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS shadow_hidden BOOLEAN DEFAULT FALSE`);
  await db(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS emoji TEXT DEFAULT ''`);
  await db(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS vip BOOLEAN DEFAULT FALSE`);
  // Товарищеские (нерейтинговые) партии: старые записи считаются рейтинговыми
  await db(`ALTER TABLE games ADD COLUMN IF NOT EXISTS rated BOOLEAN DEFAULT TRUE`);
  // Создание таблицы для дневника разработки (перенесено сюда из глобальной области)
  await db(`
    CREATE TABLE IF NOT EXISTS dev_diary (
      id         TEXT PRIMARY KEY,
      author     TEXT NOT NULL,
      title      TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS dev_diary_reactions (
      entry_id     TEXT NOT NULL,
      username_low TEXT NOT NULL,
      emoji        TEXT NOT NULL,
      created_at   BIGINT NOT NULL,
      PRIMARY KEY (entry_id, username_low)
    )
  `);
  await db(`CREATE INDEX IF NOT EXISTS idx_ddr_entry ON dev_diary_reactions(entry_id)`);

  await db(`
    CREATE TABLE IF NOT EXISTS dev_diary_comments (
      id           TEXT PRIMARY KEY,
      entry_id     TEXT NOT NULL,
      username     TEXT NOT NULL,
      username_low TEXT NOT NULL,
      content      TEXT NOT NULL,
      created_at   BIGINT NOT NULL
    )
  `);
  await db(`CREATE INDEX IF NOT EXISTS idx_ddc_entry ON dev_diary_comments(entry_id, created_at ASC)`);
  await db(`CREATE INDEX IF NOT EXISTS idx_ddc_user  ON dev_diary_comments(username_low, created_at DESC)`);

  await db(`
    CREATE TABLE IF NOT EXISTS dev_diary_comment_bans (
      username_low TEXT PRIMARY KEY,
      created_at   BIGINT NOT NULL
    )
  `);

  // Аудит-лог просмотров переписок админами (см. /api/admin/dm/*).
  await db(`
    CREATE TABLE IF NOT EXISTS admin_dm_audit (
      id         TEXT PRIMARY KEY,
      admin      TEXT NOT NULL,
      target     TEXT NOT NULL,
      partner    TEXT,
      action     TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);
  await db(`CREATE INDEX IF NOT EXISTS idx_admin_dm_audit_target ON admin_dm_audit(target, created_at DESC)`);
  await db(`CREATE INDEX IF NOT EXISTS idx_admin_dm_audit_admin  ON admin_dm_audit(admin, created_at DESC)`);

  // Общий лог всех значимых действий админов (бан/разбан, IP-баны, VIP,
  // задачи, системные сообщения, жалобы, обращения и т.п.) — максимальный
  // уровень контроля: видно, кто из админов что сделал и когда.
  await db(`
    CREATE TABLE IF NOT EXISTS admin_action_log (
      id         TEXT PRIMARY KEY,
      admin      TEXT NOT NULL,
      action     TEXT NOT NULL,
      target     TEXT,
      details    TEXT,
      created_at BIGINT NOT NULL
    )
  `);
  await db(`CREATE INDEX IF NOT EXISTS idx_admin_action_log_admin  ON admin_action_log(admin, created_at DESC)`);
  await db(`CREATE INDEX IF NOT EXISTS idx_admin_action_log_target ON admin_action_log(target, created_at DESC)`);
  await db(`CREATE INDEX IF NOT EXISTS idx_admin_action_log_action ON admin_action_log(action, created_at DESC)`);

  await loadChat();
  await loadTournaments();
  await loadTournamentChats();
  await loadClubs();
  await loadClubChats();
  await loadForum();
  await loadBlog();
  // БАГ: эти два вызова отсутствовали, из-за чего newsPosts/newsAuthors
  // оставались пустыми в памяти после каждого рестарта (pm2 restart и т.п.),
  // хотя в таблицах news_posts/news_authors в Postgres данные не терялись —
  // просто не подгружались обратно при старте процесса.
  await loadNewsAuthors();
  await loadNews();

  await db(`
    CREATE TABLE IF NOT EXISTS follows (
      follower    TEXT NOT NULL,
      following   TEXT NOT NULL,
      created_at  BIGINT NOT NULL,
      PRIMARY KEY (follower, following)
    )
  `);
  await db(`CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower)`);
  await db(`CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following)`);

  // Апелляции / обращения (тикеты) в поддержку
  await db(`
    CREATE TABLE IF NOT EXISTS appeals (
      id           TEXT PRIMARY KEY,
      username     TEXT NOT NULL,
      reason       TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'open',
      awaiting     TEXT NOT NULL DEFAULT 'admin',
      created_at   BIGINT NOT NULL,
      updated_at   BIGINT NOT NULL
    )
  `);
  await db(`CREATE INDEX IF NOT EXISTS idx_appeals_user ON appeals(username, created_at DESC)`);
  await db(`CREATE INDEX IF NOT EXISTS idx_appeals_status ON appeals(status, updated_at DESC)`);

  await db(`
    CREATE TABLE IF NOT EXISTS appeal_messages (
      id           TEXT PRIMARY KEY,
      appeal_id    TEXT NOT NULL,
      author       TEXT NOT NULL,
      is_admin     BOOLEAN NOT NULL DEFAULT FALSE,
      message      TEXT NOT NULL,
      created_at   BIGINT NOT NULL
    )
  `);
  await db(`CREATE INDEX IF NOT EXISTS idx_appeal_msgs ON appeal_messages(appeal_id, created_at ASC)`);

  if (!clubs.find(c => c.id === 'chesshome-official')) {
    // БАГ (исправлен): createdAt был new Date().toISOString() — строка в
    // BIGINT-колонку created_at clubs. При каждом чистом старте (когда сид
    // клуба создаётся) сервер падал с invalid input syntax for type bigint.
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
module.exports = {
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
  Pool,
  multer,
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
  initClubChatTable,
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
  initTournamentChatTable,
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
  initPuzzleTables,
  initQuestTables,
  getCurrentSeasonDay,
  initDurkaTables,
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
};