// ════════════════════════════════════════════════════════════════
//  Chess Home — Шахматная логика НА chess.js
// ════════════════════════════════════════════════════════════════
//  Раньше здесь был самописный движок (генерация ходов, шахи, мат,
//  рокировки, взятие на проходе, FEN/SAN/PGN — ~500 строк). Теперь
//  ВСЯ правила шахмат реализует библиотека chess.js (глобальный
//  объект Chess из /js/vendor/chess.js), а этот файл — тонкий
//  адаптер, который сохраняет прежний API ChessEngine.* для
//  board.js / app.js / editor.js / opening-board.js / tv.js,
//  чтобы ничего из них не пришлось переписывать.
//
//  Формат состояния (совместим со старым движком):
//    state.board   — Array(64), клетка: null | {type:'K'.., color:'w'|'b'}
//    state.turn    — 'w' | 'b'
//    state.castling— {K,Q,k,q}
//    state.enPassant — индекс клетки взятия на проходе | null
//    state.halfmove, state.fullmove — счётчики
//    state.history — [{from,to,piece,captured,promotion,fen,san}]
//    state.capturedWhite / capturedBlack — взятые фигуры
//  Ходы: {from: 0..63, to: 0..63, promotion?: 'Q'|'R'|'B'|'N',
//         castle?: 'K'|'Q', enPassant?: true, doublePush?: true}
// ════════════════════════════════════════════════════════════════

const ChessEngine = (() => {

  const WHITE = 'w', BLACK = 'b';

  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // ─── Координаты (чистые утилиты, без правил) ─────────────────
  function squareToIndex(sq) {
    const f = sq.charCodeAt(0) - 97;
    const r = parseInt(sq[1]) - 1;
    return r * 8 + f;
  }

  function indexToSquare(idx) {
    const f = idx % 8;
    const r = Math.floor(idx / 8);
    return String.fromCharCode(97 + f) + (r + 1);
  }

  // rank()/file() УДАЛЕНЫ (3.6): экспортировались, но нигде не использовались.
  function opposite(color) { return color === WHITE ? BLACK : WHITE; }

  // createState() УДАЛЕН (3.6): экспортировался, но не вызывался ни внутри,
  // ни снаружи — состояние создаётся через parseFEN().

  function deepClone(state) {
    return {
      board: state.board.map(p => p ? { ...p } : null),
      turn: state.turn,
      castling: { ...state.castling },
      enPassant: state.enPassant,
      halfmove: state.halfmove,
      fullmove: state.fullmove,
      history: [...state.history],
      capturedWhite: [...state.capturedWhite],
      capturedBlack: [...state.capturedBlack]
    };
  }

  // ─── Мост в chess.js ─────────────────────────────────────────
  // Собираем FEN из полей состояния вручную: состояние может быть
  // построено снаружи (редактор позиций) и не обязано быть валидной
  // партией. chess.js валидирует позицию при загрузке — это и есть
  // проверка корректности, ошибки пробрасываются наверх.
  function toFEN(state) {
    let fen = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = state.board[r * 8 + f];
        if (!p) { empty++; }
        else {
          if (empty) { fen += empty; empty = 0; }
          fen += p.color === WHITE ? p.type : p.type.toLowerCase();
        }
      }
      if (empty) fen += empty;
      if (r > 0) fen += '/';
    }
    fen += ' ' + (state.turn || WHITE);
    let cas = '';
    if (state.castling) {
      if (state.castling.K) cas += 'K';
      if (state.castling.Q) cas += 'Q';
      if (state.castling.k) cas += 'k';
      if (state.castling.q) cas += 'q';
    }
    fen += ' ' + (cas || '-');
    fen += ' ' + (state.enPassant !== null && state.enPassant !== undefined ? indexToSquare(state.enPassant) : '-');
    fen += ' ' + (state.halfmove || 0) + ' ' + (state.fullmove || 1);
    return fen;
  }

  // Собирает состояние из FEN через chess.js (бросает ошибку на
  // невалидную позицию — как и должно: теперь FEN проверяется).
  function parseFEN(fen) {
    const chess = new Chess(fen);
    const st = fenToState(chess.fen());
    return st;
  }

  function fenToState(fen) {
    const chess = new Chess(fen);
    const parts = fen.trim().split(' ');
    const board = Array(64).fill(null);
    const rows = chess.board(); // 8x8 от 8-го ранга к 1-му
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = rows[r][f];
        if (p) board[(7 - r) * 8 + f] = { type: p.type.toUpperCase(), color: p.color };
      }
    }
    const castling = { K: false, Q: false, k: false, q: false };
    if (parts[2] && parts[2] !== '-') {
      castling.K = parts[2].includes('K');
      castling.Q = parts[2].includes('Q');
      castling.k = parts[2].includes('k');
      castling.q = parts[2].includes('q');
    }
    return {
      board,
      turn: chess.turn(),
      castling,
      enPassant: parts[3] && parts[3] !== '-' ? squareToIndex(parts[3]) : null,
      halfmove: parseInt(parts[4]) || 0,
      fullmove: parseInt(parts[5]) || 1,
      history: [],
      capturedWhite: [],
      capturedBlack: []
    };
  }

  // Загружает состояние в chess.js; при невалидной позиции
  // (например, в редакторе без королей) возвращает null.
  function makeChess(state) {
    try { return new Chess(toFEN(state)); } catch (e) { return null; }
  }

  // Приводит verbose-ход chess.js к формату старого ChessEngine.
  function verboseToMove(v, fromIdx) {
    return {
      from: fromIdx,
      to: squareToIndex(v.to),
      promotion: v.promotion ? v.promotion.toUpperCase() : undefined,
      castle: v.flags.includes('k') ? 'K' : v.flags.includes('q') ? 'Q' : undefined,
      enPassant: v.flags.includes('e') || undefined,
      doublePush: v.flags.includes('b') || undefined
    };
  }

  function findVerboseMove(chess, fromIdx, toIdx, promotion) {
    const fromSq = indexToSquare(fromIdx);
    const toSq = indexToSquare(toIdx);
    const all = chess.moves({ square: fromSq, verbose: true }).filter(m => m.to === toSq);
    if (!all.length) return undefined;
    if (promotion) return all.find(m => m.promotion === String(promotion).toLowerCase());
    // Превращение без указания фигуры — по умолчанию ферзь (как в старом движке)
    return all.find(m => m.promotion === 'q') || all[0];
  }

  // ─── ЛЕГАЛЬНЫЕ ХОДЫ (генерация — chess.js) ───────────────────
  function legalMoves(state, sq) {
    const piece = state.board[sq];
    if (!piece || piece.color !== state.turn) return [];
    const chess = makeChess(state);
    if (!chess) return [];
    return chess
      .moves({ square: indexToSquare(sq), verbose: true })
      .map(v => verboseToMove(v, sq));
  }

  function allLegalMoves(state) {
    const chess = makeChess(state);
    if (!chess) return [];
    return chess.moves({ verbose: true }).map(v => verboseToMove(v, squareToIndex(v.from)));
  }

  // ─── ПРИМЕНЕНИЕ ХОДА ─────────────────────────────────────────
  // Вся механика (рокировка, взятие на проходе, превращение,
  // права на рокировку при взятии ладьи и т.д.) — внутри chess.js.
  function applyMove(state, move) {
    if (!move || !Number.isInteger(move.from) || !Number.isInteger(move.to)) return deepClone(state);
    const chess = makeChess(state);
    if (!chess) return deepClone(state);
    const piece = state.board[move.from];
    const v = findVerboseMove(chess, move.from, move.to, move.promotion);
    if (!v) return deepClone(state);

    chess.move({ from: indexToSquare(move.from), to: indexToSquare(move.to), promotion: v.promotion || undefined });

    const newState = fenToState(chess.fen());
    newState.history = [...state.history];
    newState.capturedWhite = [...state.capturedWhite];
    newState.capturedBlack = [...state.capturedBlack];

    // Учёт взятых фигур — как в старом движке
    if (v.captured) {
      const capturedPiece = { type: v.captured.toUpperCase(), color: opposite(piece.color) };
      if (capturedPiece.color === WHITE) newState.capturedWhite.push(capturedPiece);
      else newState.capturedBlack.push(capturedPiece);
    }
    return newState;
  }

  // ─── КОРОЛЬ И АТАКИ ──────────────────────────────────────────
  function findKing(state, color) {
    for (let i = 0; i < 64; i++) {
      const p = state.board[i];
      if (p && p.type === 'K' && p.color === color) return i;
    }
    return -1;
  }

  // Атакует ли фигура цвета byColor клетку sq — через chess.js.
  function isAttacked(state, sq, byColor) {
    const chess = makeChess(state);
    if (!chess) return false;
    try {
      return chess.attackers(indexToSquare(sq), byColor).length > 0;
    } catch (e) {
      return false;
    }
  }

  // ─── СТАТУС ИГРЫ ─────────────────────────────────────────────
  function getStatus(state) {
    const chess = makeChess(state);
    if (!chess) return { status: 'playing', inCheck: false };

    if (chess.isCheckmate()) {
      return { status: 'checkmate', winner: opposite(state.turn) };
    }
    if (chess.isStalemate()) {
      return { status: 'stalemate' };
    }
    if (state.halfmove >= 100) {
      return { status: 'draw', reason: 'fifty-move' };
    }
    if (chess.isInsufficientMaterial()) {
      return { status: 'draw', reason: 'insufficient-material' };
    }
    if (isThreefoldRepetition(state)) {
      return { status: 'draw', reason: 'threefold-repetition' };
    }
    const inCheck = chess.inCheck();
    return { status: inCheck ? 'check' : 'playing', inCheck };
  }

  function isInsufficientMaterial(state) {
    const chess = makeChess(state);
    if (!chess) return false;
    return chess.isInsufficientMaterial();
  }

  // Отпечаток позиции для правила троекратного повторения: расстановка
  // фигур + очередь хода + права рокировки + клетка взятия на проходе.
  function positionKey(fen) {
    return fen.split(' ').slice(0, 4).join(' ');
  }

  function isThreefoldRepetition(state) {
    const currentKey = positionKey(toFEN(state));
    let count = 0;
    // Стартовая позиция партии не попадает в history (там только позиции
    // ПОСЛЕ каждого хода) — если через цепочку ходов вернулись именно
    // к ней, её тоже нужно засчитать как одно из повторений.
    if (positionKey(START_FEN) === currentKey) count++;
    if (state.history) {
      for (const h of state.history) {
        if (h.fen && positionKey(h.fen) === currentKey) count++;
      }
    }
    return count >= 3;
  }

  // ─── SAN НОТАЦИЯ (генерирует chess.js, включая + и #) ────────
  function toSAN(state, move) {
    if (!move || !Number.isInteger(move.from) || !Number.isInteger(move.to)) return '';
    const chess = makeChess(state);
    if (!chess) return '';
    const v = findVerboseMove(chess, move.from, move.to, move.promotion);
    return v ? v.san : '';
  }

  // ─── PGN ──────────────────────────────────────────────────────
  function toPGN(state, metadata = {}) {
    const tags = {
      Event: metadata.event || 'Chess Home Game',
      Site: metadata.site || 'chesshome.app',
      Date: new Date().toISOString().split('T')[0].replace(/-/g, '.'),
      White: metadata.white || '?',
      Black: metadata.black || '?',
      Result: metadata.result || '*',
      ...metadata.extra
    };
    let pgn = Object.entries(tags).map(([k, v]) => `[${k} "${v}"]`).join('\n') + '\n\n';
    const moves = state.history;
    for (let i = 0; i < moves.length; i++) {
      if (i % 2 === 0) pgn += `${Math.floor(i/2)+1}. `;
      pgn += moves[i].san + ' ';
    }
    pgn += (metadata.result || '*');
    return pgn;
  }

  // ─── ПУБЛИЧНЫЙ API ────────────────────────────────────────────
  return {
    START_FEN,
    parseFEN,
    toFEN,
    legalMoves,
    allLegalMoves,
    applyMove,
    getStatus,
    isInsufficientMaterial,
    isThreefoldRepetition,
    toSAN,
    toPGN,
    squareToIndex,
    indexToSquare,
    findKing,
    isAttacked,
    opposite,
    deepClone
  };
})();

if (typeof module !== 'undefined') module.exports = ChessEngine;
