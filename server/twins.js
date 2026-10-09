'use strict';
// ══════════════════════════════════════════════════════════════════
//  server/twins.js — оценка вероятности «это один и тот же человек»
// ══════════════════════════════════════════════════════════════════
//  Принципы:
//   • Ничего не банит и не блокирует. Только считает и показывает админам.
//   • Сигналы хранятся ТОЛЬКО на сервере и в виде HMAC-хэшей (сырые значения
//     не сохраняются). Клиент ничего не хранит (ни cookie, ни localStorage) —
//     нарушителю нечего чистить: сигналы собираются заново при каждом заходе.
//   • Вес совпадения зависит от РЕДКОСТИ значения: совпадение, которое есть у
//     2 аккаунтов из 5000, весит много; у 400 из 5000 (типовой айфон, школьный
//     Wi-Fi, оператор с общим IP) — почти ничего.
//   • Сигналы объединяются в независимые группы (устройство / сеть / окружение
//     браузера). Одна группа не может дать вероятность выше SINGLE_GROUP_CAP.
//   • Админ может пометить пару «разные люди» (скрывается) или «один человек».
// ══════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const { db } = require('./db');

const SECRET = process.env.FP_SECRET || process.env.JWT_SECRET || 'chesshome-fp-fallback';
const RETENTION_MS = 180 * 24 * 3600 * 1000;   // 180 дней — см. privacy.html
const MAX_GROUP = 150;        // значения, общие для >150 аккаунтов, пропускаем (вес ≈ 0)
const CACHE_TTL = 60 * 1000;

// ── Семейства сигналов ─────────────────────────────────────────────
//  group — независимая группа свидетельств
//  r     — P(у одного человека значение совпадёт в двух его аккаунтах)
//  k     — «сила» семейства (насколько мы доверяем его различающей способности)
const FAMILY = {
  dev:   { group: 'dev', r: 0.55, k: 1.00, label: 'Одно устройство (серверная cookie)' },
  net:   { group: 'net', r: 0.60, k: 0.60, label: 'Один IP-адрес' },
  net24: { group: 'net', r: 0.70, k: 0.55, label: 'Одна подсеть IP' },
  gpu:   { group: 'hw',  r: 0.80, k: 0.85, label: 'Видеокарта' },
  gl:    { group: 'hw',  r: 0.75, k: 0.80, label: 'Параметры графики' },
  scr:   { group: 'hw',  r: 0.85, k: 0.70, label: 'Экран и процессор' },
  fnt:   { group: 'hw',  r: 0.70, k: 0.85, label: 'Набор шрифтов' },
  cvs:   { group: 'hw',  r: 0.60, k: 0.80, label: 'Отрисовка canvas' },
  aud:   { group: 'hw',  r: 0.60, k: 0.75, label: 'Аудио-стек' },
  loc:   { group: 'hw',  r: 0.90, k: 0.50, label: 'Часовой пояс и язык' },
};
const GROUP_LABEL = { dev: 'устройство', net: 'сеть', hw: 'окружение' };
const CLIENT_KEYS = ['gpu', 'gl', 'scr', 'fnt', 'cvs', 'aud', 'loc'];

const LOGIT_BIAS = -3.7;       // «априорная» недоверчивость
const GROUP_CAP = 7.5;
const HW_SECONDARY = 0.25;     // остальные сигналы hw-группы коррелируют — берём 25 %
const SINGLE_GROUP_CAP = 0.70; // одна группа свидетельств не даёт больше 70 %
const MIN_LISTED = 0.30;       // ниже — не показываем вообще
const INDEP_MIN = 2.5;         // группа считается «самостоятельным свидетельством», только если её вес ≥ 2.5

// ── Хэширование ────────────────────────────────────────────────────
function hmac(family, raw) {
  return crypto.createHmac('sha256', SECRET).update(family + '\0' + String(raw)).digest('hex').slice(0, 32);
}

// ── Таблицы ────────────────────────────────────────────────────────
let _ready = null;
function ensureTables() {
  if (_ready) return _ready;
  _ready = (async () => {
    await db(`CREATE TABLE IF NOT EXISTS account_signals (
      username_low TEXT   NOT NULL,
      family       TEXT   NOT NULL,
      value        TEXT   NOT NULL,
      first_seen   BIGINT NOT NULL,
      last_seen    BIGINT NOT NULL,
      seen_count   INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (username_low, family, value)
    )`);
    await db('CREATE INDEX IF NOT EXISTS idx_account_signals_fv ON account_signals (family, value)');
    await db('CREATE INDEX IF NOT EXISTS idx_account_signals_seen ON account_signals (last_seen)');
    await db(`CREATE TABLE IF NOT EXISTS twin_labels (
      a          TEXT   NOT NULL,
      b          TEXT   NOT NULL,
      label      TEXT   NOT NULL,
      by_admin   TEXT,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (a, b)
    )`);
    await seedFromUsers();
  })().catch(e => { console.error('[Twins] ensureTables:', e.message); _ready = null; throw e; });
  return _ready;
}

// Первичное заполнение из уже имеющихся данных регистрации (IP и устройство).
async function seedFromUsers() {
  const has = await db('SELECT 1 FROM account_signals LIMIT 1');
  if (has.rows.length) return;
  const r = await db(`SELECT username_low, created_device_id, created_from_ip, created_at
                        FROM users
                       WHERE created_device_id IS NOT NULL OR created_from_ip IS NOT NULL`);
  let n = 0;
  for (const u of r.rows) {
    const ts = Number(u.created_at) || Date.now();
    if (u.created_device_id) { await upsert(u.username_low, 'dev', hmac('dev', u.created_device_id), ts); n++; }
    if (u.created_from_ip && !isPrivateIp(u.created_from_ip)) {
      for (const [fam, raw] of netFamilies(u.created_from_ip)) await upsert(u.username_low, fam, hmac(fam, raw), ts);
      n++;
    }
  }
  if (n) console.log(`[Twins] Начальное заполнение из users: ${n} записей`);
}

async function upsert(usernameLow, family, value, ts) {
  await db(
    `INSERT INTO account_signals (username_low, family, value, first_seen, last_seen, seen_count)
     VALUES ($1, $2, $3, $4, $4, 1)
     ON CONFLICT (username_low, family, value)
     DO UPDATE SET last_seen = EXCLUDED.last_seen, seen_count = account_signals.seen_count + 1`,
    [usernameLow, family, value, ts]
  );
}

// ── IP ─────────────────────────────────────────────────────────────
const net = require('net');
function isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return true;
  const p = ip.replace(/^::ffff:/, '');
  if (!net.isIP(p)) return true;
  if (p === '::1' || p.startsWith('127.') || p.startsWith('10.') || p.startsWith('192.168.')) return true;
  const m = /^172\.(\d{1,2})\./.exec(p);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(p) || /^fe80:/i.test(p)) return true;
  return false;
}
function expandV6(ip) {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(Math.max(0, 8 - h.length - t.length)).fill('0');
  return [...h, ...fill, ...t].map(x => x.padStart(4, '0'));
}
function netFamilies(ipRaw) {
  const ip = String(ipRaw).replace(/^::ffff:/, '');
  if (net.isIPv4(ip)) return [['net', ip], ['net24', ip.split('.').slice(0, 3).join('.')]];
  if (net.isIPv6(ip)) {
    const g = expandV6(ip.toLowerCase());
    return [['net', g.join(':')], ['net24', g.slice(0, 4).join(':')]];   // /64
  }
  return [];
}

// ── Запись сигналов (никогда не бросает наружу, не блокирует запрос) ──
const throttle = new Map();
function throttleOk(key, ms) {
  const now = Date.now();
  const t = throttle.get(key);
  if (t && now - t < ms) return false;
  if (throttle.size > 100000) throttle.clear();
  throttle.set(key, now);
  return true;
}

async function recordPairs(username, pairs, throttleMs) {
  try {
    if (!username) return;
    await ensureTables();
    const low = String(username).toLowerCase();
    const ts = Date.now();
    for (const [family, raw] of pairs) {
      if (!FAMILY[family] || raw === undefined || raw === null || raw === '') continue;
      const value = hmac(family, raw);
      if (!throttleOk(low + '|' + family + '|' + value, throttleMs)) continue;
      await upsert(low, family, value, ts);
    }
  } catch (e) {
    console.error('[Twins] record:', e.message);
  }
}

// Вход/регистрация/подключение сокета: IP + серверная cookie устройства.
function recordLogin(username, ip, deviceId) {
  const pairs = [];
  if (ip && !isPrivateIp(ip)) pairs.push(...netFamilies(ip));
  if (deviceId) pairs.push(['dev', deviceId]);
  return recordPairs(username, pairs, 30 * 60 * 1000);
}

function sanitizeClientSignals(body) {
  const s = body && typeof body === 'object' ? body.s : null;
  if (!s || typeof s !== 'object') return null;
  const out = [];
  for (const k of CLIENT_KEYS) {
    const v = s[k];
    if (typeof v !== 'string') continue;
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(v)) continue;
    out.push([k, v]);
  }
  return out;
}

// Удаление всех сигналов аккаунта (при удалении аккаунта / по требованию).
async function forgetUser(username) {
  try {
    await ensureTables();
    const low = String(username).toLowerCase();
    await db('DELETE FROM account_signals WHERE username_low = $1', [low]);
    await db('DELETE FROM twin_labels WHERE a = $1 OR b = $1', [low]);
    cache.at = 0;
  } catch (e) { console.error('[Twins] forget:', e.message); }
}

// ── Оценка ─────────────────────────────────────────────────────────
// Вес одного совпавшего значения: k·ln(r / f), где f — доля ДРУГИХ аккаунтов,
// у которых встречается то же значение (со сглаживанием).
function weightOf(family, n, N) {
  const F = FAMILY[family];
  const f = Math.max((n - 1 + 0.5) / Math.max(N, n), 1 / (N + 1));
  return Math.max(0, F.k * Math.log(F.r / f));
}

const sigmoid = x => 1 / (1 + Math.exp(-x));

// groups: [{ family, value, users:[low,...] }]; totals: { family: число аккаунтов с этим семейством }
function scorePairs(groups, totals, labels) {
  const pairs = new Map();
  for (const g of groups) {
    const F = FAMILY[g.family];
    if (!F) continue;
    const users = Array.from(new Set(g.users)).sort();
    const n = users.length;
    if (n < 2 || n > MAX_GROUP) continue;
    const w = weightOf(g.family, n, totals[g.family] || n);
    if (w <= 0) continue;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const key = users[i] + '|' + users[j];
        let p = pairs.get(key);
        if (!p) { p = { a: users[i], b: users[j], ev: [] }; pairs.set(key, p); }
        p.ev.push({ family: g.family, n, w });
      }
    }
  }

  const out = [];
  for (const p of pairs.values()) {
    const lab = labels.get(p.a + '|' + p.b);
    if (lab === 'different') continue;

    const byGroup = {};
    for (const e of p.ev) (byGroup[FAMILY[e.family].group] = byGroup[FAMILY[e.family].group] || []).push(e);

    let logit = LOGIT_BIAS;
    const groupsHit = [];
    for (const [grp, list] of Object.entries(byGroup)) {
      const ws = list.map(e => e.w).sort((x, y) => y - x);
      let gw = ws[0];
      if (grp === 'hw') for (let i = 1; i < ws.length; i++) gw += HW_SECONDARY * ws[i];
      gw = Math.min(gw, GROUP_CAP);
      if (gw >= INDEP_MIN) groupsHit.push(grp);
      logit += gw;
    }
    let prob = sigmoid(logit);
    if (groupsHit.length <= 1) prob = Math.min(prob, SINGLE_GROUP_CAP);
    prob = Math.min(prob, 0.99);

    const confirmed = lab === 'same';
    if (confirmed) prob = 1;
    if (prob < MIN_LISTED && !confirmed) continue;

    p.ev.sort((x, y) => y.w - x.w);
    out.push({
      a: p.a, b: p.b, p: Math.round(prob * 1000) / 1000, confirmed,
      groups: groupsHit.map(g => GROUP_LABEL[g]),
      evidence: p.ev.map(e => ({ family: e.family, label: FAMILY[e.family].label, n: e.n, w: Math.round(e.w * 10) / 10 })),
    });
  }
  out.sort((x, y) => y.p - x.p);
  return out;
}

// ── Загрузка из БД + кэш ───────────────────────────────────────────
const cache = { at: 0, pairs: [], stats: {} };

async function computeAll() {
  await ensureTables();
  const [tot, grp, lab, sz] = await Promise.all([
    db('SELECT family, COUNT(DISTINCT username_low)::int AS n FROM account_signals GROUP BY family'),
    db(`SELECT family, value, array_agg(username_low) AS users
          FROM account_signals
         GROUP BY family, value
        HAVING COUNT(*) BETWEEN 2 AND $1`, [MAX_GROUP]),
    db('SELECT a, b, label FROM twin_labels'),
    db(`SELECT (SELECT COUNT(*)::int FROM users) AS accounts,
               (SELECT COUNT(DISTINCT username_low)::int FROM account_signals WHERE family = 'gpu') AS with_hw,
               (SELECT COUNT(DISTINCT username_low)::int FROM account_signals WHERE family = 'net') AS with_net`),
  ]);
  const totals = {};
  for (const r of tot.rows) totals[r.family] = r.n;
  const labels = new Map(lab.rows.map(r => [r.a + '|' + r.b, r.label]));
  const pairs = scorePairs(grp.rows, totals, labels);
  cache.pairs = pairs;
  cache.stats = { accounts: sz.rows[0].accounts, withHw: sz.rows[0].with_hw, withNet: sz.rows[0].with_net };
  cache.at = Date.now();
  return cache;
}

async function getAll() {
  if (Date.now() - cache.at > CACHE_TTL) await computeAll();
  return cache;
}

// ── HTTP ───────────────────────────────────────────────────────────
function mount(app, deps) {
  const { authMiddleware, requireAdmin, logAdminAction, getIP } = deps;

  // Приём сигналов окружения браузера (клиент: /js/sig.js).
  const perUser = new Map();
  app.post('/api/sig', authMiddleware, async (req, res) => {
    try {
      const username = req.user && req.user.username;
      if (!username) return res.status(401).json({ error: 'Требуется вход' });
      const now = Date.now();
      const rec = perUser.get(username) || { n: 0, reset: now + 10 * 60 * 1000 };
      if (now > rec.reset) { rec.n = 0; rec.reset = now + 10 * 60 * 1000; }
      if (++rec.n > 8) return res.status(429).json({ error: 'Слишком часто' });
      perUser.set(username, rec);
      if (perUser.size > 20000) perUser.clear();

      const pairs = sanitizeClientSignals(req.body);
      if (!pairs) return res.status(400).json({ error: 'Некорректные данные' });
      const ip = getIP(req);
      if (!isPrivateIp(ip)) pairs.push(...netFamilies(ip));
      if (req.deviceId) pairs.push(['dev', req.deviceId]);
      await recordPairs(username, pairs, 6 * 3600 * 1000);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'Ошибка' });
    }
  });

  // Список вероятных дубликатов.
  app.get('/api/admin/twins', authMiddleware, async (req, res) => {
    await requireAdmin(req, res, async () => {
      try {
        const min = Math.max(0, Math.min(1, parseFloat(req.query.min)));
        const minP = Number.isFinite(min) ? min : 0.5;
        const q = String(req.query.username || '').trim().toLowerCase();
        const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 80));
        const all = await getAll();

        let pairs = all.pairs.filter(p => p.confirmed || p.p >= minP);
        if (q) pairs = pairs.filter(p => p.a.includes(q) || p.b.includes(q));
        pairs = pairs.slice(0, limit);

        const names = Array.from(new Set(pairs.flatMap(p => [p.a, p.b])));
        const info = new Map();
        if (names.length) {
          const u = await db(
            'SELECT username, username_low, banned, role, rating, created_at FROM users WHERE username_low = ANY($1)',
            [names]
          );
          for (const r of u.rows) info.set(r.username_low, {
            username: r.username, banned: !!r.banned, role: r.role, rating: r.rating, createdAt: Number(r.created_at),
          });
        }
        const view = u => info.get(u) || { username: u, banned: false, role: 'user', rating: null, createdAt: null };
        res.json({
          pairs: pairs.map(p => ({ ...p, userA: view(p.a), userB: view(p.b) })),
          stats: all.stats,
          generatedAt: all.at,
        });
      } catch (e) {
        console.error('[Twins] list:', e.message);
        res.status(500).json({ error: 'Ошибка расчёта' });
      }
    });
  });

  // Пометка пары: different | same | clear
  app.post('/api/admin/twins/label', authMiddleware, async (req, res) => {
    await requireAdmin(req, res, async () => {
      try {
        const a0 = String(req.body.a || '').toLowerCase().trim();
        const b0 = String(req.body.b || '').toLowerCase().trim();
        const label = String(req.body.label || '');
        if (!a0 || !b0 || a0 === b0) return res.status(400).json({ error: 'Укажите два разных аккаунта' });
        if (!['different', 'same', 'clear'].includes(label)) return res.status(400).json({ error: 'Неверная метка' });
        const [a, b] = a0 < b0 ? [a0, b0] : [b0, a0];
        await ensureTables();
        if (label === 'clear') await db('DELETE FROM twin_labels WHERE a = $1 AND b = $2', [a, b]);
        else await db(
          `INSERT INTO twin_labels (a, b, label, by_admin, created_at) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (a, b) DO UPDATE SET label = EXCLUDED.label, by_admin = EXCLUDED.by_admin, created_at = EXCLUDED.created_at`,
          [a, b, label, req.user.username, Date.now()]
        );
        cache.at = 0;
        try { await logAdminAction(req.user.username, 'twin_label', a + ' / ' + b, { label }); } catch (e) {}
        res.json({ ok: true });
      } catch (e) {
        console.error('[Twins] label:', e.message);
        res.status(500).json({ error: 'Ошибка' });
      }
    });
  });

  // Ежедневная очистка старых сигналов.
  const t = setInterval(async () => {
    try { await ensureTables(); await db('DELETE FROM account_signals WHERE last_seen < $1', [Date.now() - RETENTION_MS]); }
    catch (e) { console.error('[Twins] cleanup:', e.message); }
  }, 24 * 3600 * 1000);
  if (t.unref) t.unref();

  ensureTables().catch(() => {});
}

module.exports = { mount, recordLogin, forgetUser, _internals: { scorePairs, weightOf, netFamilies, isPrivateIp, FAMILY } };