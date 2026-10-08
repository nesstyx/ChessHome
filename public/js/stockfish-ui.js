// ══════════════════════════════════════════════════════════════
//  Chess Home — Модуль анализа Stockfish
// ══════════════════════════════════════════════════════════════

const StockfishAnalyzer = (() => {
  let sf = null;
  let isReady = false;
  let analyzing = false;
  // Неиспользуемая currentCallback УДАЛЕНА (3.6).
  // Домашний воркер (см. worker-client/) — сильнее и не грузит браузер
  // посетителя. Пробуем его первым; если недоступен/все заняты — сервер
  // сразу ответит analyze_unavailable, и просто продолжаем локально,
  // как раньше. Ни один из путей не обязателен для работы другого.
  let usingRemote = false;
  let remoteFallbackTimer = null;
  let pendingRemote = null; // { fen, depth } — что запросили удалённо, на случай фолбэка

  function init() {
    try {
      // Загружаем stockfish локально с нашего сервера (нет CORS проблем)
      sf = new Worker('/js/stockfish.js');
      sf.onmessage = handleMessage;
      sf.onerror = (e) => {
        console.warn('Stockfish worker error:', e);
        setEngineStatus('error');
        document.getElementById('engine-status-text').textContent = 'Движок недоступен (скачайте stockfish.js)';
      };
      sf.postMessage('uci');
      sf.postMessage('setoption name MultiPV value 1');
      setEngineStatus('loading');
      return true;
    } catch (e) {
      console.warn('Stockfish load failed:', e);
      setEngineStatus('error');
      return false;
    }
  }

  function handleMessage(e) {
    const line = e.data || e;
    if (typeof line !== 'string') return;

    if (line === 'uciok') {
      sf.postMessage('isready');
    }

    if (line === 'readyok') {
      isReady = true;
      setEngineStatus('ready');
    }

    if (line.startsWith('info depth')) {
      parseInfo(line);
    }

    if (line.startsWith('bestmove')) {
      const parts = line.split(' ');
      const bestMove = parts[1];
      if (bestMove && bestMove !== '(none)') {
        document.getElementById('best-move-uci').textContent = formatUCIMove(bestMove);
      }
      // AI-комментатор (issue #71): движок закончил считать позицию —
      // сравниваем финальную оценку с предыдущей и, если позиция качнулась,
      // выдаём весёлую фразу на странице анализа.
      if (lastParsed && typeof AICommentator !== 'undefined') {
        AICommentator.onBestMove(lastParsed.evalNum, lastParsed.mate);
        lastParsed = null;
      }
      setEngineStatus('ready');
      analyzing = false;
    }
  }

  // Последняя распарсенная инфо-строка (финальная оценка текущего поиска)
  let lastParsed = null;

  function parseInfo(line) {
    const tokens = line.split(' ');
    const get = (key) => {
      const i = tokens.indexOf(key);
      return i !== -1 ? tokens[i+1] : null;
    };

    const depth = get('depth');
    const scoreCP = get('cp');
    const scoreMate = get('mate');
    const pv = (() => {
      const i = tokens.indexOf('pv');
      return i !== -1 ? tokens.slice(i+1, i+10).join(' ') : '';
    })();
    const multipv = get('multipv');

    if (multipv && multipv !== '1') return; // Only show line 1

    let evalText = '';
    let evalNum = 0;

    if (scoreMate) {
      const m = parseInt(scoreMate);
      evalText = m > 0 ? `M${m}` : `M${-m}`;
      evalNum = m > 0 ? 999 : -999;
    } else if (scoreCP !== null) {
      evalNum = parseInt(scoreCP) / 100;
      evalText = (evalNum > 0 ? '+' : '') + evalNum.toFixed(2);
    }

    // Check if it's black's perspective
    const isBlackTurn = line.includes(' bm ') || checkBlackTurn();
    if (isBlackTurn) {
      evalNum = -evalNum;
      // БАГ (исправлен): при ходе чёрных формат мата затирался числом
      // ("-999.00" вместо "M-3"). Корректируем знак мата отдельно.
      if (scoreMate) {
        const m = Math.abs(parseInt(scoreMate));
        evalText = evalNum > 0 ? ('M' + m) : ('M-' + m);
      } else {
        evalText = evalNum > 0 ? '+' + evalNum.toFixed(2) : evalNum.toFixed(2);
      }
    }

    const evalEl = document.getElementById('eval-score');
    if (evalEl) {
      evalEl.textContent = scoreMate ? evalText : evalText;
      evalEl.className = 'eval-score' + (evalNum < 0 ? ' negative' : '');
    }

    const depthEl = document.getElementById('eval-depth');
    if (depthEl) depthEl.textContent = `Глубина: ${depth}`;

    const pvEl = document.getElementById('pv-line');
    if (pvEl) pvEl.textContent = pv || '';

    // Update eval bar
    updateEvalBar(evalNum);

    // Запоминаем финальную оценку для AI-комментатора (после bestmove)
    lastParsed = { evalNum, mate: !!scoreMate };
  }

  function checkBlackTurn() {
    return typeof chessBoard !== 'undefined' && chessBoard.state.turn === 'b';
  }

  function updateEvalBar(evalNum) {
    const bar = document.getElementById('eval-bar-fill');
    if (!bar) return;
    // Convert eval to percentage (0-100, 50 = equal)
    const pct = 50 + Math.min(Math.max(evalNum * 5, -45), 45);
    bar.style.height = pct + '%';
  }

  function analyze(fen, depth = 18) {
    // Сначала пробуем домашний воркер — если сокет подключён, шлём запрос
    // и ждём подтверждения. Если за 1.5с сервер не откликнулся (или сразу
    // прислал analyze_unavailable — воркеров нет/все заняты), уходим на
    // локальный анализ в браузере, как было раньше.
    if (typeof socket !== 'undefined' && socket && socket.connected) {
      usingRemote = true;
      pendingRemote = { fen, depth };
      analyzing = true;
      setEngineStatus('thinking');
      socket.emit('analyze_request', { fen, depth });
      clearTimeout(remoteFallbackTimer);
      remoteFallbackTimer = setTimeout(() => {
        if (usingRemote && pendingRemote) { usingRemote = false; analyzeLocal(fen, depth); }
      }, 1500);
      return;
    }
    analyzeLocal(fen, depth);
  }

  function analyzeLocal(fen, depth) {
    if (!sf) {
      init();
      setTimeout(() => analyzeLocal(fen, depth), 500);
      return;
    }
    if (!isReady) { setTimeout(() => analyzeLocal(fen, depth), 200); return; }
    analyzing = true;
    setEngineStatus('thinking');
    sf.postMessage('position fen ' + fen);
    sf.postMessage(`go depth ${depth}`);
  }

  // Прилетела строка от домашнего воркера (сырой UCI-вывод настоящего
  // Stockfish) — это ровно тот же формат, что и у локального движка в
  // браузере, поэтому просто прогоняем через тот же handleMessage().
  function handleRemoteMessage(line) {
    clearTimeout(remoteFallbackTimer);
    pendingRemote = null;
    handleMessage(line);
  }

  // Сервер сообщил, что воркеров нет/все заняты (сразу, или воркер
  // отвалился прямо во время анализа) — падаем на локальный движок.
  function handleRemoteUnavailable() {
    clearTimeout(remoteFallbackTimer);
    if (usingRemote && pendingRemote) {
      const { fen, depth } = pendingRemote;
      usingRemote = false;
      pendingRemote = null;
      analyzeLocal(fen, depth);
    }
  }

  function stop() {
    if (usingRemote) {
      if (typeof socket !== 'undefined' && socket) socket.emit('analyze_cancel');
      usingRemote = false;
      pendingRemote = null;
      clearTimeout(remoteFallbackTimer);
      analyzing = false;
      return;
    }
    if (sf && analyzing) { sf.postMessage('stop'); }
  }

  function setEngineStatus(status) {
    const dot = document.getElementById('engine-dot');
    const text = document.getElementById('engine-status-text');
    if (!dot || !text) return;
    dot.className = 'engine-dot ' + status;
    const labels = { ready: 'Готов', thinking: 'Анализирует...', error: 'Ошибка загрузки', loading: 'Загрузка...' };
    text.textContent = labels[status] || status;
  }

  function formatUCIMove(uci) {
    if (!uci || uci.length < 4) return uci;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promo = uci[4] ? uci[4].toUpperCase() : '';
    return from + '-' + to + (promo ? '=' + promo : '');
  }

  return { init, analyze, stop, isReady: () => isReady, handleRemoteMessage, handleRemoteUnavailable };
})();

// Global function to request analysis
function requestAnalysis() {
  const fen = chessBoard.getFEN();
  StockfishAnalyzer.analyze(fen, 20);
}

// ══════════════════════════════════════════════════════════════
//  AI-комментатор (issue #71): весёлые фразы по данным Stockfish.
//  Реагирует на качели оценки между проанализированными позициями:
//  грубые ошибки, переломы, маты — плюс нейтральные реплики.
// ══════════════════════════════════════════════════════════════
const AICommentator = (() => {
  let lastEval = null;      // последняя финальная оценка (перспектива белых)
  let lastPhraseAt = 0;     // антиспам: не чаще раза в 2.5 секунды
  const MIN_INTERVAL = 2500;

  function t(key, fallback) {
    try {
      const v = window.CH_I18N ? window.CH_I18N.t(key) : undefined;
      if (v && v !== key) return v;
    } catch (e) { /* i18n недоступен */ }
    return fallback;
  }

  function rand(n) { return 1 + Math.floor(Math.random() * n); }

  function say(text) {
    const box = document.getElementById('ai-commentary');
    if (!box || !text) return;
    box.textContent = text;
    // Перезапускаем анимацию появления фразы
    box.classList.remove('ai-say');
    void box.offsetWidth;
    box.classList.add('ai-say');
  }

  // Вызывается после bestmove: evalNum — оценка в перспективе белых,
  // isMate — движок нашёл мат в текущей позиции.
  function onBestMove(evalNum, isMate) {
    if (typeof evalNum !== 'number' || !isFinite(evalNum)) return;
    const now = Date.now();
    if (now - lastPhraseAt < MIN_INTERVAL) { lastEval = evalNum; return; }

    const prev = lastEval;
    lastEval = evalNum;

    // Первая позиция сессии — иногда здороваемся
    if (prev === null) {
      if (Math.random() < 0.5) { lastPhraseAt = now; say(t('ai.phrase_greeting_' + rand(3), null)); }
      return;
    }

    if (isMate) {
      lastPhraseAt = now;
      say(t('ai.phrase_mate_' + rand(3), null));
      return;
    }

    const delta = evalNum - prev;
    const absDelta = Math.abs(delta);

    if (absDelta >= 3) {
      lastPhraseAt = now;
      say(t((delta > 0 ? 'ai.phrase_blunder_white_' : 'ai.phrase_blunder_black_') + rand(3), null));
      return;
    }
    if (absDelta >= 1.5) {
      lastPhraseAt = now;
      say(t((delta > 0 ? 'ai.phrase_swing_white_' : 'ai.phrase_swing_black_') + rand(3), null));
      return;
    }
    if (absDelta >= 0.7 && Math.random() < 0.6) {
      lastPhraseAt = now;
      say(t('ai.phrase_small_' + rand(3), null));
      return;
    }
    // Позиция почти не изменилась — изредка вставляем нейтральную реплику
    if (Math.random() < 0.1) {
      lastPhraseAt = now;
      say(t('ai.phrase_quiet_' + rand(4), null));
    }
  }

  // Кнопка 🎲 — выдать фразу по запросу
  function manual() {
    const pool = Math.random();
    let key;
    if (pool < 0.4)      key = 'ai.phrase_quiet_' + rand(4);
    else if (pool < 0.7) key = 'ai.phrase_greeting_' + rand(3);
    else if (pool < 0.85) key = 'ai.phrase_small_' + rand(3);
    else                 key = 'ai.phrase_idle_' + rand(3);
    say(t(key, null));
  }

  function reset() { lastEval = null; }

  return { onBestMove, manual, reset };
})();

// Кнопка «Ещё фразу» на странице анализа
function nextAiPhrase() {
  if (typeof AICommentator !== 'undefined') AICommentator.manual();
}

// Инициализацию страницы анализа выполняет единственный хук pages['analysis']
// в app.js (раньше здесь был дубль, который сбрасывал доску на стартовую
// позицию и затирал позицию, переданную из редактора — issue #23).