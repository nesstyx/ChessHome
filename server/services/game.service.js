// ═══════════════════════════════════════════════════════════════
//  services/game.service.js — активные партии, часы, завершение игр
// ═══════════════════════════════════════════════════════════════
//  Карты активных партий, серверные шахматные правила (chess.js-адаптер),
//  авторитарные часы и финал партии, запись результатов и пересчёт
//  рейтинга (Эло через Go-сервис с фолбэком на JS-формулу).
//  Доступ к общим объектам (io, usersCache, findSocketByUsername)
//  — ленивый через require('../core'), чтобы избежать циклических
//  зависимостей на этапе загрузки модулей.
// ═══════════════════════════════════════════════════════════════

const { db, withTransaction } = require('../db');

const tournamentService = require('./tournament.service');


// ── Активные партии ───────────────────────────────────────────
const activeGames       = new Map();

const tournamentGames   = new Map();


// ── Часы партии — источник истины ТОЛЬКО сервер ────────────────
// Сервер сам считает оставшееся время по game.lastMoveAt и не
// доверяет клиентским заявлениям о таймауте.
function liveClock(game, now) {
  let { whiteTime, blackTime } = game;
  // До первого хода белых время не сгорает: просрочку первого хода
  // контролирует отдельный дедлайн game.firstMoveDeadline (см. тик ниже).
  if (game.moves.length === 0) return { whiteTime, blackTime };
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
    const t = tournamentService.tournaments.find(t => t.id === game.tournamentId);
    if (t) await tournamentService.finishTournamentGame(t, game, result, reason);
  } else if (hasFullMove(game)) {
    await recordGame(game, result, reason);
    await updateStats(game.white, game.black, result, game.rated !== false);
  }
  const core = require('../core');
  const payload = { gameId, result, reason, white: game.white, black: game.black };
  [core.findSocketByUsername(game.white), core.findSocketByUsername(game.black)].forEach(s => s?.emit('game_ended', payload));
}


// Каждую секунду проверяем все активные партии на падение флага —
// независимо от того, что показывает (или не показывает) клиент.
// Тело тика обёрнуто в try/catch: ошибка БД/логики внутри одного тика
// не должна ронять процесс Node.js необработанным rejection.
setInterval(() => {
  try {
    const now = Date.now();
    for (const [gameId, game] of activeGames.entries()) {
      // Дедлайн первого хода: просрочка авторитарно завершает партию
      // сервером, без участия клиента. Турнирные партии обслуживает
      // тик tournament.service.js (там свой дедлайн FIRST_MOVE_TIMEOUT).
      // moves.length === 0 — белые не сходили (побеждают чёрные);
      // moves.length === 1 — белые сходили, а чёрные не ответили
      // (дедлайн им продлевался в sockets.js, побеждают белые).
      if (!game.tournamentId && game.firstMoveDeadline && now > game.firstMoveDeadline) {
        if (game.moves.length === 0) {
          console.log(`[Clock] Первый ход просрочен: ${game.white} (белые) в игре ${gameId}`);
          endGameAuthoritative(gameId, game, 'black', 'timeout_firstmove')
            .catch(e => console.error('[Clock]', e.message));
        } else if (game.moves.length === 1) {
          console.log(`[Clock] Ответный ход просрочен: ${game.black} (чёрные) в игре ${gameId}`);
          endGameAuthoritative(gameId, game, 'white', 'timeout_firstmove')
            .catch(e => console.error('[Clock]', e.message));
        }
        continue;
      }
      if (game.whiteTime === undefined || game.blackTime === undefined) continue;
      const { whiteTime, blackTime } = liveClock(game, now);
      if (whiteTime <= 0) endGameAuthoritative(gameId, game, 'black', 'timeout').catch(e => console.error('[Clock]', e.message));
      else if (blackTime <= 0) endGameAuthoritative(gameId, game, 'white', 'timeout').catch(e => console.error('[Clock]', e.message));
    }
  } catch (e) {
    console.error('[Clock tick]', e);
  }
}, 1000);


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
    // Формула Эло с коэффициентом K=32
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
  // Статистика обновляется атомарно: транзакция + SELECT ... FOR UPDATE
  // блокирует строки обоих игроков, инкременты выполняются одним
  // атомарным UPDATE, и кэш синхронизируется из фактических значений БД.
  const core = require('../core');
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
      const w = await core.getUser(wLow);
      const b = await core.getUser(bLow);
      if (w) { Object.assign(w, { rating: finalW.wRow.rating, gamesPlayed: finalW.wRow.games_played, wins: finalW.wRow.wins, losses: finalW.wRow.losses, draws: finalW.wRow.draws }); core.cacheUser(w); }
      if (b) { const r2 = await db('SELECT rating, games_played, wins, losses, draws FROM users WHERE username_low = $1', [bLow]);
        if (r2.rows[0]) Object.assign(b, { rating: r2.rows[0].rating, gamesPlayed: r2.rows[0].games_played, wins: r2.rows[0].wins, losses: r2.rows[0].losses, draws: r2.rows[0].draws }); core.cacheUser(b); }
    }
  } catch (e) {
    console.error('[updateStats]', e.message);
  }
}


// ── Товарищеская партия по вызову из лобби ────────────────────
// До первого хода белые часы не сгорают вовсе (см. liveClock), поэтому
// бездействие ограничено отдельным дедлайном: через 30с без хода сервер
// завершает партию авторитарно (timeout_firstmove).
const FRIENDLY_FIRST_MOVE_TIMEOUT = 30 * 1000;

function startGame(acceptorSocket, challenge) {
  const core = require('../core');
  const gameId = core.uuidv4();
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
  const game = {
    id: gameId, white, black, turn: 'white', moves: [], createdAt: gameNow, lastActivity: gameNow,
    timeControl: challenge.timeControl, whiteTime: tcSec, blackTime: tcSec, tcIncrement: tcInc || 0,
    // До первого хода белых часы не тикают (lastMoveAt = null) — партия
    // живёт под защитой дедлайна firstMoveDeadline.
    lastMoveAt: null,
    firstMoveDeadline: gameNow + FRIENDLY_FIRST_MOVE_TIMEOUT,
    _board: serverChess.startBoard(), rated,
  };
  activeGames.set(gameId, game);
  const wR = core.usersCache.get(white.toLowerCase())?.rating ?? '?';
  const bR = core.usersCache.get(black.toLowerCase())?.rating ?? '?';
  const ws = core.findSocketByUsername(white); const bs = core.findSocketByUsername(black);
  const startPayload = { gameId, timeControl: game.timeControl, rated, serverAt: Date.now(), lastMoveAt: game.lastMoveAt, firstMoveDeadline: game.firstMoveDeadline, whiteTime: game.whiteTime, blackTime: game.blackTime };
  if (ws) ws.emit('game_start', { ...startPayload, color: 'white', opponent: black, opponentRating: bR });
  if (bs) bs.emit('game_start', { ...startPayload, color: 'black', opponent: white, opponentRating: wR });
}


// ── Шахматные правила НА chess.js ─────────────────────────────
// Вся логика правил — в библиотеке chess.js, модуль лишь адаптирует
// её к внутреннему формату партии:
//   board   = { squares: Array(64) из null | [ТИП,'w'|'b'],
//               turn: 'w'|'b', castling: {wK,wQ,bK,bQ}, epSquare: idx|-1 }
//   move    = { from: 0..63, to: 0..63, promotion?: 'q'|'Q', ep?, castle? }
const serverChess = (() => {
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
    // Превращение без указания фигуры — ферзь
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
  // либо исходный move, если совпадение не нашлось.
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


// Экспорт дополняется через Object.assign (а не перезаписывается), потому что
// tournament.service.js захватывает module.exports этого модуля В МОМЕНТ
// циклического require на этапе загрузки — перезапись здесь оставила бы там
// пустой объект и сломала бы все обращения к gameService.* из турнирного сервиса.
Object.assign(module.exports, {
  activeGames,
  tournamentGames,
  liveClock,
  hasFullMove,
  endGameAuthoritative,
  recordGame,
  calcNewRatings,
  updateStats,
  startGame,
  FRIENDLY_FIRST_MOVE_TIMEOUT,
  serverChess,
});
