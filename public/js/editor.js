// ══════════════════════════════════════════════════════════════
//  Chess Home — Редактор позиции
// ══════════════════════════════════════════════════════════════

const BoardEditor = (() => {
  let board = Array(64).fill(null);
  let selectedPiece = null; // {type, color} | 'eraser' | null
  let editorTurn = 'w';

  // i18n-хелпер: словарь может быть ещё не загружен — тогда русский fallback
  function T(key, fallback) {
    try {
      const v = window.CH_I18N ? window.CH_I18N.t(key) : undefined;
      if (v && v !== key) return v;
    } catch (e) { /* i18n недоступен */ }
    return fallback !== undefined ? fallback : key;
  }

  // ─── ИНИЦИАЛИЗАЦИЯ ────────────────────────────────────────
  function initFromStart() {
    const st = ChessEngine.parseFEN(ChessEngine.START_FEN);
    board = [...st.board];
    editorTurn = 'w';
    render();
  }

  function initEmpty() {
    board = Array(64).fill(null);
    board[4]  = { type: 'K', color: 'w' };
    board[60] = { type: 'K', color: 'b' };
    render();
  }

  // ─── РЕНДЕР ДОСКИ ─────────────────────────────────────────
  function render() {
    const el = document.getElementById('editor-board');
    if (!el) return;

    // Принудительно выставляем размеры (фикс сплющивания строк)
    el.style.cssText = `
      width: min(480px, calc(100vw - 220px));
      height: min(480px, calc(100vw - 220px));
      display: grid;
      grid-template-columns: repeat(8, 1fr);
      grid-template-rows: repeat(8, 1fr);
      border: 3px solid var(--accent-dark);
      border-radius: 4px;
      overflow: hidden;
    `;

    let html = '';
    for (let r = 7; r >= 0; r--) {
      for (let f = 0; f < 8; f++) {
        const sq = r * 8 + f;
        const light = (r + f) % 2 !== 0;
        const piece = board[sq];

        // Подсветка выбранной клетки (если фигура на ней совпадает с selectedSq)
        const isSelected = selectedSq === sq;

        html += `<div class="square ${light ? 'light' : 'dark'}${isSelected ? ' selected' : ''}"
          data-sq="${sq}"
          style="width:100%;height:100%;position:relative;"
          onclick="BoardEditor.handleEditorClick(${sq})"
          ondragover="event.preventDefault()"
          ondrop="BoardEditor.handleEditorDrop(event, ${sq})">
          ${piece ? `<div class="piece" draggable="true"
            ondragstart="BoardEditor.handleEditorDragStart(event, ${sq})">
            <img src="${PIECE_IMGS[piece.color + piece.type]}" alt="${piece.color}${piece.type}">
          </div>` : ''}
          ${r === 0 ? `<span style="position:absolute;right:2px;bottom:2px;font-size:10px;font-weight:600;font-family:var(--font-mono);color:${light ? 'var(--board-dark)' : 'var(--board-light)'};line-height:1;pointer-events:none">${String.fromCharCode(97 + f)}</span>` : ''}
          ${f === 0 ? `<span style="position:absolute;left:2px;top:2px;font-size:10px;font-weight:600;font-family:var(--font-mono);color:${light ? 'var(--board-dark)' : 'var(--board-light)'};line-height:1;pointer-events:none">${r + 1}</span>` : ''}
        </div>`;
      }
    }
    el.innerHTML = html;
    updateFENInput();
  }

  // ─── КЛИК ПО КЛЕТКЕ ────────────────────────────────────────
  // Логика:
  // 1. Ластик выбран → стираем фигуру
  // 2. Фигура из палитры выбрана → ставим её
  // 3. Ничего не выбрано, кликнули на фигуру → "берём" её (selectedSq)
  // 4. Уже держим фигуру с доски, кликнули на другую клетку → перемещаем
  // 5. Кликнули на ту же клетку → отменяем выбор

  let selectedSq = null; // индекс клетки с "взятой" фигурой с доски

  function handleEditorClick(sq) {
    // Ластик
    if (selectedPiece === 'eraser') {
      board[sq] = null;
      render();
      return;
    }

    // Фигура из палитры выбрана — ставим
    if (selectedPiece && typeof selectedPiece === 'object') {
      board[sq] = { ...selectedPiece };
      render();
      return;
    }

    // Ничего из палитры не выбрано — работаем с фигурами на доске
    if (selectedSq === null) {
      // Берём фигуру с доски
      if (board[sq]) {
        selectedSq = sq;
        render();
      }
      return;
    }

    // Уже держим фигуру
    if (selectedSq === sq) {
      // Клик на ту же клетку — отменяем
      selectedSq = null;
      render();
      return;
    }

    // Перемещаем фигуру
    board[sq] = board[selectedSq];
    board[selectedSq] = null;
    selectedSq = null;
    render();
  }

  // ─── DRAG & DROP ──────────────────────────────────────────
  let dragFrom = null;

  function handleEditorDragStart(e, sq) {
    dragFrom = sq;
    selectedSq = null;
    e.dataTransfer.setData('text/plain', sq);
  }

  function handleEditorDrop(e, sq) {
    e.preventDefault();
    if (dragFrom === null) return;
    if (dragFrom !== sq) {
      board[sq] = board[dragFrom];
      board[dragFrom] = null;
    }
    dragFrom = null;
    render();
  }

  // ─── ПАЛИТРА ──────────────────────────────────────────────
  function selectPalettePiece(type, color) {
    selectedPiece = { type, color };
    selectedSq = null; // снимаем выбор с доски
    document.querySelectorAll('.palette-piece, .eraser-btn').forEach(b => b.classList.remove('selected'));
    document.querySelector(`[data-piece-key="${color}${type}"]`)?.classList.add('selected');
  }

  function selectEraser() {
    selectedPiece = 'eraser';
    selectedSq = null;
    document.querySelectorAll('.palette-piece').forEach(b => b.classList.remove('selected'));
    document.querySelector('.eraser-btn')?.classList.add('selected');
  }

  function deselectAll() {
    selectedPiece = null;
    selectedSq = null;
    document.querySelectorAll('.palette-piece, .eraser-btn').forEach(b => b.classList.remove('selected'));
  }

  // ─── FEN ──────────────────────────────────────────────────
  function updateFENInput() {
    const state = boardToState();
    const fen = ChessEngine.toFEN(state);
    const input = document.getElementById('editor-fen');
    if (input) input.value = fen;
  }

  function boardToState() {
    const castling = { K: false, Q: false, k: false, q: false };
    const is = (sq, type, color) => {
      const p = board[sq];
      return !!p && p.type === type && p.color === color;
    };
    if (is(4, 'K', 'w')) {            // e1
      if (is(7, 'R', 'w'))  castling.K = true;  // h1
      if (is(0, 'R', 'w'))  castling.Q = true;  // a1
    }
    if (is(60, 'K', 'b')) {           // e8
      if (is(63, 'R', 'b')) castling.k = true;  // h8
      if (is(56, 'R', 'b')) castling.q = true;  // a8
    }

    return {
      board: [...board],
      turn: editorTurn,
      castling,
      enPassant: null,
      halfmove: 0,
      fullmove: 1,
      history: [],
      capturedWhite: [],
      capturedBlack: []
    };
  }

  function loadFromFEN() {
    const input = document.getElementById('editor-fen');
    if (!input) return;
    try {
      const state = ChessEngine.parseFEN(input.value.trim());
      board = [...state.board];
      editorTurn = state.turn;
      deselectAll();
      render();
      toast(T('editor.fen_loaded', 'Позиция загружена'), 'success');
    } catch { toast(T('editor.fen_invalid', 'Неверный FEN'), 'error'); }
  }

  // ─── АНАЛИЗ ───────────────────────────────────────────────
  // Передаём FEN текущей позиции редактора на страницу анализа через
  function analyzePosition() {
    // Для анализа нужны оба короля — иначе позиция невалидна
    const kings = board.filter(p => p && p.type === 'K').length;
    if (kings !== 2) {
      toast(T('editor.analysis_needs_kings', 'Для анализа нужны оба короля на доске'), 'error');
      return;
    }

    const fen = ChessEngine.toFEN(boardToState());
    try {
      sessionStorage.setItem('ch_analysis_fen', fen);
    } catch (e) {
      toast(T('editor.analysis_failed', 'Не удалось передать позицию в анализ'), 'error');
      return;
    }

    showPage('analysis');
    toast(T('editor.analysis_started', 'Анализ позиции запущен!'), 'success');
  }

  // ─── ПРОЧЕЕ ───────────────────────────────────────────────
  function setTurn(color) {
    editorTurn = color;
    updateFENInput();
    document.querySelectorAll('.turn-btn').forEach(b =>
      b.classList.toggle('selected', b.dataset.turn === color)
    );
  }

  function clearBoard() {
    board = Array(64).fill(null);
    deselectAll();
    render();
  }

  // ─── PUBLIC API ────────────────────────────────────────────
  return {
    initFromStart,
    initEmpty,
    render,
    handleEditorClick,
    handleEditorDragStart,
    handleEditorDrop,
    selectPalettePiece,
    selectEraser,
    loadFromFEN,
    analyzePosition,
    setTurn,
    clearBoard
  };
})();

// ─── СТРАНИЦА РЕДАКТОРА ────────────────────────────────────────
pages['editor'] = () => {
  // Строим палитру здесь — к этому моменту PIECE_IMGS точно загружен
  const TYPES = ['K', 'Q', 'R', 'B', 'N', 'P'];
  ['w', 'b'].forEach(color => {
    const containerId = color === 'w' ? 'palette-white' : 'palette-black';
    const el = document.getElementById(containerId);
    if (!el) return;
    // Перестраиваем каждый раз чтобы src были актуальными
    el.innerHTML = TYPES.map(t => `
      <div class="palette-piece" data-piece-key="${color}${t}" title="${t}"
        onclick="BoardEditor.selectPalettePiece('${t}','${color}')">
        <img src="${PIECE_IMGS[color + t]}" alt="${t}">
      </div>
    `).join('');
  });

  BoardEditor.initFromStart();
};