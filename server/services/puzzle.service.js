'use strict';
// ═══════════════════════════════════════════════════════════════
//  puzzle.service.js — задачи: проверка ходов и рейтинг (Glicko-2)
// ═══════════════════════════════════════════════════════════════
//  Принципы:
//   1) Сервер — единственный судья. Клиент шлёт только ход (UCI),
//      позицию, шаг и результат ведёт сервер (сессия на пару
//      «пользователь + задача»). Присланным «moveIndex» и списком
//      ходов мы больше не пользуемся.
//   2) Ход считается верным, если он совпал с решением (в решении
//      можно писать варианты через «|») ИЛИ если он ставит мат.
//      Поэтому у «мата в 1 ход» с двумя решениями засчитывается
//      любой из них.
//   3) Рейтинг считается один раз — за ПЕРВУЮ попытку пользователя
//      в задаче (ошибка или решение, что наступит раньше). Повторы
//      тренировочные: рейтинг не меняется. Рейтинг и у игрока, и у
//      задачи обновляется по Glicko-2.
//   4) Решение клиенту не отдаётся никогда.
//
//  Состояние сессий хранится в памяти процесса (так же, как stormRuns).
// ═══════════════════════════════════════════════════════════════

const { v4: uuidv4 } = require('uuid');

// Зависимости подгружаются лениво (и подменяются в тестах).
const deps = { Chess: null, db: null, withTransaction: null };
function D() {
  if (!deps.Chess) deps.Chess = require('chess.js').Chess;
  if (!deps.db || !deps.withTransaction) {
    const m = require('../db');
    deps.db = m.db;
    deps.withTransaction = m.withTransaction;
  }
  return deps;
}

// ── Параметры Glicko-2 ─────────────────────────────────────────
const SCALE = 173.7178;
const TAU = 1.1;                 // «инерция» волатильности (0.3–1.2)
const MAX_RD = 250;              // потолок неопределённости (в т.ч. после долгого простоя)
const USER_START_RD = 150;       // новичок: рейтинг двигается быстро, пока не «откалибруется»
const MIN_RD_USER = 110;
const MIN_RD_PUZZLE = 50;
const MIN_VOL = 0.05;
const MAX_VOL = 0.3;
const DEFAULT_VOL = 0.12;
const PERIODS_PER_DAY = 0.2;     // 1 «период» = ~5 дней: столько растёт RD у тех, кто не заходит
const USER_START_RATING = 1200;
const USER_MIN_RATING = 100;
const PUZZLE_MIN_RATING = 100;
const PUZZLE_MAX_RATING = 3500;
const PUZZLE_START_RD = 150;
const DIFF_RATING = { easy: 1200, medium: 1850, hard: 2500 };

function g(phi) { return 1 / Math.sqrt(1 + 3 * phi * phi / (Math.PI * Math.PI)); }
function expected(mu, muJ, phiJ) { return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ))); }

// Обновление Glicko-2 по списку партий (в нашем случае — одна «партия»:
// игрок против задачи). periods — сколько «рейтинговых периодов» прошло
// с прошлого обновления (рост неопределённости за время простоя).
function glicko2Update(player, games, opts) {
  const o = opts || {};
  const tau = o.tau != null ? o.tau : TAU;
  const periods = o.periods != null ? o.periods : 1;
  const minRd = o.minRd != null ? o.minRd : 30;
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.vol;

  if (!games.length) {
    const phiStar = Math.sqrt(phi * phi + periods * sigma * sigma);
    return { rating: player.rating, rd: Math.min(MAX_RD, Math.max(minRd, phiStar * SCALE)), vol: sigma };
  }

  let vInv = 0, deltaSum = 0;
  for (const gm of games) {
    const muJ = (gm.rating - 1500) / SCALE;
    const phiJ = gm.rd / SCALE;
    const gj = g(phiJ);
    const Ej = expected(mu, muJ, phiJ);
    vInv += gj * gj * Ej * (1 - Ej);
    deltaSum += gj * (gm.score - Ej);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;

  // Новая волатильность (алгоритм Illinois, Glickman 2013, шаг 5)
  const a = Math.log(sigma * sigma);
  const f = (x) => {
    const ex = Math.exp(x);
    const d2 = phi * phi + v + ex;
    return ex * (delta * delta - phi * phi - v - ex) / (2 * d2 * d2) - (x - a) / (tau * tau);
  };
  let A = a, B;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0 && k < 100) k++;
    B = a - k * tau;
  }
  let fA = f(A), fB = f(B);
  for (let i = 0; Math.abs(B - A) > 1e-6 && i < 100; i++) {
    const C = A + (A - B) * fA / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else { fA = fA / 2; }
    B = C; fB = fC;
  }
  const sigmaNew = Math.min(MAX_VOL, Math.max(MIN_VOL, Math.exp(A / 2)));

  const phiStar = Math.sqrt(phi * phi + periods * sigmaNew * sigmaNew);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * deltaSum;

  return {
    rating: muNew * SCALE + 1500,
    rd: Math.min(MAX_RD, Math.max(minRd, phiNew * SCALE)),
    vol: sigmaNew,
  };
}

function periodsSince(ts, now) {
  if (!ts) return 0;
  const days = Math.max(0, (now - ts) / 86400000);
  return Math.min(days * PERIODS_PER_DAY, 40);
}

// Одна попытка: пересчитываем и игрока, и задачу (каждый использует
// СТАРЫЕ значения соперника, как и требует Glicko).
function rateAttempt(u, p, solved, now) {
  const newU = glicko2Update(
    u, [{ rating: p.rating, rd: p.rd, score: solved ? 1 : 0 }],
    { periods: periodsSince(u.ratedAt, now), minRd: MIN_RD_USER }
  );
  const newP = glicko2Update(
    p, [{ rating: u.rating, rd: u.rd, score: solved ? 0 : 1 }],
    { periods: periodsSince(p.ratedAt, now), minRd: MIN_RD_PUZZLE }
  );

  

  newU.rating = Math.max(USER_MIN_RATING, newU.rating);
  newP.rating = Math.min(PUZZLE_MAX_RATING, Math.max(PUZZLE_MIN_RATING, newP.rating));
  return { user: newU, puzzle: newP };
}

function userStateFromRow(row) {
  const attempted = Number(row.puzzle_attempted) || 0;
  const rating = row.puzzle_glicko != null ? Number(row.puzzle_glicko)
               : row.puzzle_rating != null ? Number(row.puzzle_rating) : USER_START_RATING;
  // Тем, кто решал задачи ещё до Glicko, даём «стартовую» неопределённость
  // по числу попыток: меньше попыток — быстрее двигается рейтинг.
  const rd = row.puzzle_rd != null ? Number(row.puzzle_rd)
           : Math.min(USER_START_RD, Math.max(60, USER_START_RD - attempted * 3));
  const vol = row.puzzle_vol != null ? Number(row.puzzle_vol) : DEFAULT_VOL;
  return { rating, rd, vol, ratedAt: row.puzzle_rated_at != null ? Number(row.puzzle_rated_at) : 0 };
}

function puzzleStateFromRow(row) {
  const rating = row.rating != null ? Number(row.rating) : (DIFF_RATING[row.difficulty] || DIFF_RATING.medium);
  const rd = row.rating_rd != null ? Number(row.rating_rd) : PUZZLE_START_RD;
  const vol = row.rating_vol != null ? Number(row.rating_vol) : DEFAULT_VOL;
  return { rating, rd, vol, ratedAt: row.rating_at != null ? Number(row.rating_at) : 0 };
}

// Рейтинг задачи для выдачи наружу (целое число).
function publicPuzzleRating(row) {
  return Math.round(puzzleStateFromRow(row).rating);
}

// ── Схема БД (идемпотентно, выполняется один раз при старте) ───
let schemaPromise = null;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const { db } = D();
      await db('ALTER TABLE users   ADD COLUMN IF NOT EXISTS puzzle_glicko   double precision');
      await db('ALTER TABLE users   ADD COLUMN IF NOT EXISTS puzzle_rd       double precision');
      await db('ALTER TABLE users   ADD COLUMN IF NOT EXISTS puzzle_vol      double precision');
      await db('ALTER TABLE users   ADD COLUMN IF NOT EXISTS puzzle_rated_at bigint');
      await db('ALTER TABLE puzzles ADD COLUMN IF NOT EXISTS rating          double precision');
      await db('ALTER TABLE puzzles ADD COLUMN IF NOT EXISTS rating_rd       double precision');
      await db('ALTER TABLE puzzles ADD COLUMN IF NOT EXISTS rating_vol      double precision');
      await db('ALTER TABLE puzzles ADD COLUMN IF NOT EXISTS rating_at       bigint');

      // Какой системой набран рейтинг: 1 = старая (+15/−10), 2 = Glicko-2.
      // У новых пользователей по умолчанию 2. Один раз, при создании колонки,
      // всем, кто уже решал задачи, ставим 1 — им в таблице лидеров покажется
      // «OLD Rating System», пока они сами не сбросят рейтинг.
      const had = await db(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'puzzle_rating_system'`);
      await db('ALTER TABLE users ADD COLUMN IF NOT EXISTS puzzle_rating_system smallint NOT NULL DEFAULT 2');
      if (!had.rows.length) {
        await db('UPDATE users SET puzzle_rating_system = 1 WHERE COALESCE(puzzle_attempted, 0) > 0');
      }
    })().catch((e) => {
      schemaPromise = null; // повторим при следующем обращении
      console.error('[PuzzleService] ensureSchema:', e.message);
      throw e;
    });
  }
  return schemaPromise;
}

// ── Шахматная часть ────────────────────────────────────────────
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const stripAnno = (v) => String(v == null ? '' : v).replace(/[+#!?]/g, '').trim().toLowerCase();

function parseSolution(solution) {
  const all = String(solution || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return {
    playerMoves: all.filter((_, i) => i % 2 === 0),
    autoMoves:   all.filter((_, i) => i % 2 === 1),
  };
}

// Судит ход решающего в позиции fen.
//   { legal:false }                       — ход невозможен (штрафа нет)
//   { fallback:true }                     — chess.js не смог разобрать FEN
//   { legal:true, matches, mate, canon, fenAfter }
// matches — совпал с решением; mate — ход ставит мат.
function judgeSolverMove(fen, uciRaw, expectedRaw) {
  const { Chess } = D();
  const played = stripAnno(uciRaw);
  if (!UCI_RE.test(played)) return { legal: false };
  let chess;
  try { chess = new Chess(fen); } catch (e) { return { fallback: true }; }

  const from = played.slice(0, 2), to = played.slice(2, 4), promo = played[4];
  const cands = chess.moves({ verbose: true }).filter((m) => m.from === from && m.to === to);
  if (!cands.length) return { legal: false };
  // Превращение без указания фигуры = ферзь (как и раньше).
  const mv = promo
    ? cands.find((m) => m.promotion === promo)
    : (cands.find((m) => m.promotion === 'q') || cands[0]);
  if (!mv) return { legal: false };

  chess.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
  const canon = mv.from + mv.to + (mv.promotion || '');
  const variants = String(expectedRaw || '').split('|').map(stripAnno).filter(Boolean);
  const matches = variants.some((v) => canon === v || (v.length === 4 && canon.startsWith(v)));
  return { legal: true, matches, mate: chess.isCheckmate(), canon, fenAfter: chess.fen() };
}

// Запасной вариант, если chess.js не принял FEN: сравнение строк (без проверки мата).
function legacyMatch(uciRaw, expectedRaw) {
  const played = stripAnno(uciRaw);
  if (!UCI_RE.test(played)) return false;
  return String(expectedRaw || '').split('|').map(stripAnno).filter(Boolean)
    .some((v) => played === v || (v.length === 4 && played.startsWith(v))
      || (v.length === 5 && v.endsWith('q') && played === v.slice(0, 4)));
}

// Применяет ход соперника из решения. null — если ход невозможен.
function applyUci(fen, uciRaw) {
  const { Chess } = D();
  const u = stripAnno(uciRaw);
  if (!UCI_RE.test(u)) return null;
  try {
    const chess = new Chess(fen);
    chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    return chess.fen();
  } catch (e) { return null; }
}

// ── Сессии решения ─────────────────────────────────────────────
const sessions = new Map();           // `${userId}:${puzzleId}` -> session
const SESSION_TTL_MS = 6 * 3600 * 1000;
const SESSIONS_MAX = 50000;
const keyOf = (userId, puzzleId) => userId + ':' + puzzleId;

function putSession(s) {
  const k = keyOf(s.userId, s.puzzleId);
  if (sessions.has(k)) sessions.delete(k);
  else if (sessions.size >= SESSIONS_MAX) {
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) sessions.delete(oldest);
  }
  sessions.set(k, s);
}
function sweepSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [k, s] of sessions) if (s.touchedAt < cutoff) sessions.delete(k);
}
const sweepTimer = setInterval(sweepSessions, 10 * 60 * 1000);
if (sweepTimer.unref) sweepTimer.unref();

async function startSession(userId, puzzle) {
  await ensureSchema();
  const { db } = D();
  const ex = await db('SELECT 1 FROM puzzle_attempts WHERE user_id=$1 AND puzzle_id=$2 LIMIT 1', [userId, puzzle.id]);
  const rated = !ex.rows.length;
  const { playerMoves, autoMoves } = parseSolution(puzzle.solution);
  const now = Date.now();
  putSession({
    userId, puzzleId: puzzle.id, fen: puzzle.fen, step: 0,
    playerMoves, autoMoves, rated,
    resolved: false,   // рейтинг за эту сессию уже учтён (или не положен)
    finished: false,   // задача решена
    mistakes: 0, result: null,
    createdAt: now, touchedAt: now,
  });
  return { rated };
}

// Рейтинг за первую попытку. Возвращает null, если попытка уже была
// (гонка двух вкладок) — тогда рейтинг не трогаем.
async function applyRatedResult(userId, puzzleId, solved) {
  await ensureSchema();
  const { withTransaction } = D();
  const now = Date.now();
  return withTransaction(async (client) => {
    // Уникальность (user_id, puzzle_id) в БД гарантирует «один раз».
    const ins = await client.query(
      `INSERT INTO puzzle_attempts (id,user_id,puzzle_id,correct,created_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id,puzzle_id) DO NOTHING RETURNING id`,
      [uuidv4(), userId, puzzleId, solved, now]
    );
    if (!ins.rows.length) return null;

    const ur = await client.query(
      `SELECT puzzle_rating, puzzle_glicko, puzzle_rd, puzzle_vol, puzzle_rated_at, puzzle_attempted
         FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    const pr = await client.query(
      `SELECT difficulty, rating, rating_rd, rating_vol, rating_at
         FROM puzzles WHERE id = $1 FOR UPDATE`, [puzzleId]);
    if (!ur.rows[0] || !pr.rows[0]) throw new Error('user_or_puzzle_missing'); // откатит и попытку

    const u = userStateFromRow(ur.rows[0]);
    const p = puzzleStateFromRow(pr.rows[0]);
    const res = rateAttempt(u, p, solved, now);

    const oldShown = Math.round(u.rating);
    const newShown = Math.round(res.user.rating);

    const upd = await client.query(
      `UPDATE users SET
         puzzle_rating = $1, puzzle_glicko = $2, puzzle_rd = $3, puzzle_vol = $4, puzzle_rated_at = $5,
         puzzle_attempted = COALESCE(puzzle_attempted, 0) + 1,
         puzzle_solved    = COALESCE(puzzle_solved, 0) + $6
       WHERE id = $7
       RETURNING puzzle_rating, puzzle_solved, puzzle_attempted`,
      [newShown, res.user.rating, res.user.rd, res.user.vol, now, solved ? 1 : 0, userId]
    );
    await client.query(
      `UPDATE puzzles SET
         rating = $1, rating_rd = $2, rating_vol = $3, rating_at = $4,
         play_count    = COALESCE(play_count, 0) + 1,
         correct_count = COALESCE(correct_count, 0) + $5
       WHERE id = $6`,
      [res.puzzle.rating, res.puzzle.rd, res.puzzle.vol, now, solved ? 1 : 0, puzzleId]
    );

    return {
      rated: true,
      delta: newShown - oldShown,
      newRating: newShown,
      rd: Math.round(res.user.rd),
      userRow: upd.rows[0],     // routes.js обновит им кэш пользователя
    };
  });
}

// Повторное (нерейтинговое) решение после ошибки: только статус «решено».
async function markSolvedUnrated(userId, puzzleId) {
  const { db } = D();
  await db('UPDATE puzzle_attempts SET correct = true WHERE user_id = $1 AND puzzle_id = $2 AND correct = false', [userId, puzzleId]);
}

// Обработка хода игрока.
//   { status:'restart' }  — сессии нет (например, перезапуск сервера)
//   { status:'illegal' }  — невозможный ход, штрафа нет
//   { status:'done' }     — задача уже решена в этой сессии
//   { status:'ok', correct, finished, autoMove, rating }
async function handleMove(userId, puzzle, uciRaw, moveIndexHint) {
  let s = sessions.get(keyOf(userId, puzzle.id));
  if (!s) {
    // Старый клиент не вызывал /start: если это первый ход — стартуем сами.
    const hint = Number(moveIndexHint);
    if (!moveIndexHint || hint === 0) { await startSession(userId, puzzle); s = sessions.get(keyOf(userId, puzzle.id)); }
    else return { status: 'restart' };
  }
  s.touchedAt = Date.now();
  if (s.finished) return { status: 'done' };

  const expectedRaw = s.playerMoves[s.step];
  if (!expectedRaw) return { status: 'restart' };

  let solved, mate = false, fenAfter = null;
  const j = judgeSolverMove(s.fen, uciRaw, expectedRaw);
  if (j.fallback) {
    solved = legacyMatch(uciRaw, expectedRaw);
    if (!UCI_RE.test(stripAnno(uciRaw))) return { status: 'illegal' };
  } else {
    if (!j.legal) return { status: 'illegal' };
    mate = j.mate;
    solved = j.matches || j.mate;     // мат всегда засчитывается
    fenAfter = j.fenAfter;
  }

  // ── Ошибка ──
  if (!solved) {
    s.mistakes++;
    let rating = null;
    if (!s.resolved) {
      s.resolved = true;
      if (s.rated) rating = await applyRatedResult(userId, puzzle.id, false);
      s.result = rating;
    }
    return { status: 'ok', correct: false, finished: false, autoMove: null, rating };
  }

  // ── Верный ход: задача окончена? ──
  const lastStep = s.step >= s.playerMoves.length - 1;
  let autoMove = null, nextFen = null, finished;
  if (mate || lastStep) {
    finished = true;
  } else if (j.fallback) {
    autoMove = s.autoMoves[s.step] || null;       // позицию не ведём — отдаём ход как есть
    finished = false;
  } else {
    autoMove = s.autoMoves[s.step] || null;
    nextFen = autoMove ? applyUci(fenAfter, autoMove) : null;
    if (nextFen) finished = false;
    else { autoMove = null; finished = true; }    // в данных ход соперника невозможен — не ломаем игрока
  }

  if (!finished) {
    if (nextFen) s.fen = nextFen;
    s.step++;
    return { status: 'ok', correct: true, finished: false, autoMove, rating: null };
  }

  s.finished = true;
  let rating = null;
  if (!s.resolved) {
    s.resolved = true;
    if (s.rated) rating = await applyRatedResult(userId, puzzle.id, true);
    s.result = rating;
  } else if (s.mistakes > 0) {
    await markSolvedUnrated(userId, puzzle.id);
  }
  return { status: 'ok', correct: true, finished: true, autoMove: null, rating };
}

// Можно ли пользователю показать кнопку «Сбросить старый рейтинг».
async function getRatingStatus(userId) {
  await ensureSchema();
  const { db } = D();
  const r = await db('SELECT puzzle_rating, puzzle_rating_system FROM users WHERE id = $1', [userId]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    canReset: Number(row.puzzle_rating_system) === 1,
    rating: row.puzzle_rating != null ? Number(row.puzzle_rating) : USER_START_RATING,
  };
}

// Сброс старого рейтинга: начинаем с 1200 и «свежей» неопределённостью по Glicko-2.
// Решённые задачи и счётчики остаются. Одноразово: после сброса флаг = 2.
// null — сбрасывать нечего (уже сбрасывал / не играл по старой системе).
async function resetRating(userId) {
  await ensureSchema();
  const { db } = D();
  const r = await db(
    `UPDATE users SET
       puzzle_rating = $1, puzzle_glicko = $2, puzzle_rd = $3, puzzle_vol = $4,
       puzzle_rated_at = NULL, puzzle_rating_system = 2
     WHERE id = $5 AND puzzle_rating_system = 1
     RETURNING puzzle_rating, puzzle_solved, puzzle_attempted`,
    [USER_START_RATING, USER_START_RATING, USER_START_RD, DEFAULT_VOL, userId]
  );
  return r.rows[0] || null;
}

// Итог последней сессии (для старых клиентов, которые зовут /attempt).
function getSessionResult(userId, puzzleId) {
  const s = sessions.get(keyOf(userId, puzzleId));
  if (!s) return null;
  return { finished: s.finished, mistakes: s.mistakes, rating: s.result };
}

module.exports = {
  ensureSchema,
  startSession,
  handleMove,
  getSessionResult,
  getRatingStatus,
  resetRating,
  judgeSolverMove,
  applyUci,
  legacyMatch,
  parseSolution,
  publicPuzzleRating,
  // для тестов
  glicko2Update,
  rateAttempt,
  _deps: deps,
  _sessions: sessions,
};