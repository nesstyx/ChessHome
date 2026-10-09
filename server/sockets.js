// ═══════════════════════════════════════════════════════════════
//  sockets.js — вся логика Socket.IO (реалтайм: игра, чат, турниры)
// ═══════════════════════════════════════════════════════════════

const {
  uuidv4,
  parseCookieHeader,
  socketLimiter,
  bannedIPs,
  bannedDevices,
  saveBanToDB,
  usersCache,
  isVip,
  getUser,
  saveUser,
  globalChat,
  saveChatMsg,
  tournaments,
  saveTournament,
  clubs,
  isClubModerator,
  canWriteInClubChat,
  io,
  sessions,
  usernameToSocketId,
  onlineUsers,
  pendingChallenges,
  activeGames,
  tournamentGames,
  workers,
  analyzeJobs,
  pickIdleWorker,
  removeUserChatMessages,
  safeSecretEqual,
  isTrustedProxyPeer,
  cleanIpHeader,
  sanitizeTournament,
  getTournamentStatus,
  verifyToken,
  // hasFullMove/recordGame/updateStats/finishTournamentGame здесь больше не
  // нужны (P1): resign/accept_draw переведены на endGameAuthoritative и
  // сами партию не завершают.
  endGameAuthoritative,
  findSocketByUsername,
  emitToAdmins,
  tryPairTournamentPlayers,
  FIRST_MOVE_TIMEOUT,
  startGame,
  serverChess,
  limiterSocketConnect,
} = require('./core');
const twins = require('./twins');
const moderation = require('./moderation');

// ── Жизненный цикл вызовов (challenges) ────────────────────────
const CHALLENGE_TTL_MS = 60000;
setInterval(() => {
  const now = Date.now();
  for (let i = pendingChallenges.length - 1; i >= 0; i--) {
    if (now - pendingChallenges[i].createdAt > CHALLENGE_TTL_MS) pendingChallenges.splice(i, 1);
  }
}, 30000).unref();

const workerAuthFails = new Map(); // ip -> { count, resetAt }
const WORKER_AUTH_MAX_FAILS = 5;
const WORKER_AUTH_WINDOW_MS = 10 * 60 * 1000;
function isWorkerAuthBlocked(ip) {
  const d = workerAuthFails.get(ip);
  if (!d) return false;
  if (Date.now() > d.resetAt) { workerAuthFails.delete(ip); return false; }
  return d.count >= WORKER_AUTH_MAX_FAILS;
}
function registerWorkerAuthFail(ip) {
  const now = Date.now();
  let d = workerAuthFails.get(ip);
  if (!d || now > d.resetAt) {
    if (workerAuthFails.size > 10000) workerAuthFails.clear(); // защита памяти
    d = { count: 0, resetAt: now + WORKER_AUTH_WINDOW_MS };
    workerAuthFails.set(ip, d);
  }
  d.count++;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, d] of workerAuthFails) if (now > d.resetAt) workerAuthFails.delete(ip);
}, 60 * 1000).unref();
// Строка от воркера — только вывод UCI-движка («info …» / «bestmove …»): ASCII,
// без угловых скобок и кавычек, не длиннее 1000 символов.
function sanitizeUciLine(line) {
  if (typeof line !== 'string' || line.length > 1000) return null;
  return /^(info|bestmove)[A-Za-z0-9 .\-_:=+\/()]*$/.test(line) ? line : null;
}
if (process.env.WORKER_SECRET && process.env.WORKER_SECRET.length < 24) {
  console.warn('⚠️  WORKER_SECRET короче 24 символов — задайте длинный случайный секрет: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"');
}

io.on('connection', (socket) => {
  // Socket.io не использует req.ip — читаем заголовок напрямую из handshake.
  const peerAddr = socket.handshake.address;
  const socketIP = (
    (isTrustedProxyPeer(peerAddr) ? cleanIpHeader(socket.handshake.headers['x-real-ip']) : null)
    || peerAddr
    || 'unknown'
  );

  if (bannedIPs.has(socketIP)) {
    const banCheckTimer = setTimeout(() => { if (!socket.username) socket.disconnect(true); }, 3000);
    socket.once('auth', () => clearTimeout(banCheckTimer));
  }

  if (!limiterSocketConnect.check(socketIP).allowed) { socket.disconnect(true); return; }

  // ── ДОМАШНИЙ WORKER: аутентификация по секретному токену ──────
  // Если задан WORKER_SECRET в .env — принимаем воркер-подключения.
  // Если не задан вообще — фича просто выключена, ничего не ломается.
  socket.on('worker_auth', (payload) => {
    if (isWorkerAuthBlocked(socketIP)) {
      socket.emit('worker_auth_error', 'Слишком много попыток, подождите');
      socket.disconnect(true);
      return;
    }
    const secret = typeof payload === 'string' ? payload : payload?.secret;
    if (!process.env.WORKER_SECRET || typeof secret !== 'string' || !safeSecretEqual(secret, process.env.WORKER_SECRET)) {
      registerWorkerAuthFail(socketIP);
      socket.emit('worker_auth_error', 'Неверный секрет');
      socket.disconnect(true);
      return;
    }
    const threads = (typeof payload === 'object' && Number.isInteger(payload?.threads))
      ? Math.max(1, Math.min(payload.threads, 64)) : 1;
    workers.set(socket.id, { socket, threads, busy: false, lastSeen: Date.now() });
    socket.isWorker = true;
    socket.emit('worker_auth_ok');
    console.log(`[Worker] Подключился (${threads} поток(а/ов)). Всего воркеров онлайн: ${workers.size}`);
  });
  socket.on('worker_heartbeat', () => {
    const w = workers.get(socket.id);
    if (w) w.lastSeen = Date.now();
  });
  // Воркер прислал промежуточную строку анализа ("info depth ...") —
  // пересылаем её как есть тому браузеру, который заказал анализ.
  // Формат строки — родной UCI-вывод Stockfish, парсер на клиенте
  // (stockfish-ui.js) уже умеет такие строки читать — не важно,
  // пришли они от локального движка в браузере или от воркера.
  // Принимаем только от аутентифицированного воркера, которому задача выдана,
  socket.on('worker_job_progress', (msg) => {
    if (!socket.isWorker || !msg || typeof msg !== 'object') return;
    const job = analyzeJobs.get(msg.jobId);
    if (!job || job.workerSocketId !== socket.id) return;
    const line = sanitizeUciLine(msg.line);
    if (!line) return;
    const requester = io.sockets.sockets.get(job.requesterSocketId);
    if (requester) requester.emit('analyze_line', line);
  });
  socket.on('worker_job_done', (msg) => {
    if (!socket.isWorker || !msg || typeof msg !== 'object') return;
    const job = analyzeJobs.get(msg.jobId);
    if (!job || job.workerSocketId !== socket.id) return;
    const line = sanitizeUciLine(msg.line);
    const requester = io.sockets.sockets.get(job.requesterSocketId);
    if (requester && line) requester.emit('analyze_line', line);
    const w = workers.get(job.workerSocketId);
    if (w) w.busy = false;
    analyzeJobs.delete(msg.jobId);
  });

  // ── Запрос анализа от обычного посетителя (страница «Анализ») ──
  socket.on('analyze_request', ({ fen, depth }) => {
    if (typeof fen !== 'string' || fen.length > 100) return;
    const safeDepth = Number.isInteger(depth) ? Math.max(1, Math.min(depth, 30)) : 18;
    const w = pickIdleWorker();
    if (!w) { socket.emit('analyze_unavailable'); return; } // клиент сам уйдёт на локальный анализ в браузере
    const jobId = uuidv4();
    w.busy = true;
    analyzeJobs.set(jobId, { requesterSocketId: socket.id, workerSocketId: w.socket.id });
    w.socket.emit('worker_job', { jobId, fen, depth: safeDepth });
  });
  socket.on('analyze_cancel', () => {
    for (const [jobId, job] of analyzeJobs.entries()) {
      if (job.requesterSocketId === socket.id) {
        const w = workers.get(job.workerSocketId);
        if (w) { w.socket.emit('worker_job_cancel', { jobId }); w.busy = false; }
        analyzeJobs.delete(jobId);
      }
    }
  });
  socket.on('disconnect', () => {
    if (socket.isWorker && workers.has(socket.id)) {
      workers.delete(socket.id);
      // Если у этого воркера была незавершённая задача — сообщаем
      // заказчику, чтобы он не завис в ожидании, а ушёл на локальный
      // анализ в браузере.
      for (const [jobId, job] of analyzeJobs.entries()) {
        if (job.workerSocketId === socket.id) {
          const requester = io.sockets.sockets.get(job.requesterSocketId);
          if (requester) requester.emit('analyze_unavailable');
          analyzeJobs.delete(jobId);
        }
      }
      console.log(`[Worker] Отключился. Воркеров онлайн: ${workers.size}`);
    }
  });

  // Обёртка над socket.on: rate-limit + изоляция ошибок.
  const origOn = socket.on.bind(socket);
  socket.on = function(event, handler) {
    if (event === 'connect' || event === 'disconnect' || event === 'error') return origOn(event, handler);
    return origOn(event, (...args) => {
      if (!socketLimiter.check(socket.id + '_' + event).allowed) { socket.emit('error', 'Слишком много запросов. Притормози!'); return; }
      try {
        const r = handler(...args);
        if (r && typeof r.catch === 'function') {
          r.catch(e => { console.error(`[SocketHandler] ${event}:`, e); socket.emit('error', 'Внутренняя ошибка сервера'); });
        }
      } catch (e) {
        console.error(`[SocketHandler] ${event}:`, e);
        socket.emit('error', 'Внутренняя ошибка сервера');
      }
    });
  };

  socket.on('auth', async (_clientSuppliedToken) => {
    // Токен читаем ТОЛЬКО из HttpOnly-cookie в заголовках handshake —
    // аргумент, присланный клиентом, больше не используется, т.к. JS
    // на странице не может (и не должен) знать значение httpOnly-токена.
    const handshakeCookies = parseCookieHeader(socket.handshake.headers.cookie);
    const token = handshakeCookies.ch_token;
    const p = token ? verifyToken(token) : null;
    if (!p) return socket.emit('auth_error', 'Неверный токен');
    if (bannedIPs.has(socketIP)) { socket.emit('auth_error', 'Ваш IP заблокирован'); socket.disconnect(); return; }

    const lower = p.username.toLowerCase();
    let ids = usernameToSocketId.get(lower);
    const isFirstSocket = !ids || ids.size === 0;
    if (!ids) { ids = new Set(); usernameToSocketId.set(lower, ids); }
    ids.add(socket.id);
    sessions.set(socket.id, { username: p.username });
    if (isFirstSocket) onlineUsers.add(p.username);
    socket.username = p.username;
    twins.recordLogin(p.username, socketIP, handshakeCookies.ch_device_id);

    const user = await getUser(p.username.toLowerCase());
    if (user?.banned) { socket.emit('auth_error', 'Аккаунт заблокирован: ' + (user.banReason || 'нарушение правил')); socket.disconnect(); return; }

    socket.emit('auth_ok', { username: p.username });
    io.emit('online_count', onlineUsers.size);
    // Автоматически возвращаем игрока в очередь поиска соперника после
    // короткого обрыва связи (см. пометку "_resumeOnReconnect" в disconnect-хендлере),
    // если он именно искал партию, а не поставил паузу сам руками.
    for (const t of tournaments) {
      const tp = t.participants.find(tp => tp.username === p.username);
      if (!tp) continue;
      if (tp._resumeOnReconnect) {
        tp._resumeOnReconnect = false;
        if (!tp.left && !tp.anticheatBanned && !tp.currentGameId && getTournamentStatus(t, Date.now()) === 'active') {
          tp.waiting = true;
          io.to(`tournament_${t.id}`).emit('tournament_update', sanitizeTournament(t));
          saveTournament(t).catch(() => {});
          tryPairTournamentPlayers(t);
        }
      }
    }
    for (const [gId, game] of activeGames.entries()) {
      if (game.white === p.username || game.black === p.username) {
        const color = game.white === p.username ? 'white' : 'black';
        const opponent = color === 'white' ? game.black : game.white;
        const oppRating = usersCache.get(opponent.toLowerCase())?.rating ?? '?';
        let rejoinWhiteTime = game.whiteTime, rejoinBlackTime = game.blackTime;
        if (game.lastMoveAt !== null && rejoinWhiteTime !== undefined) {
          const elapsedSince = (Date.now() - game.lastMoveAt) / 1000;
          if (game.turn === 'white') rejoinWhiteTime = Math.max(0, rejoinWhiteTime - elapsedSince);
          else                       rejoinBlackTime = Math.max(0, rejoinBlackTime - elapsedSince);
        }
        socket.emit('game_start', { gameId: gId, color, opponent, opponentRating: oppRating, timeControl: game.timeControl, moves: game.moves, whiteTime: rejoinWhiteTime, blackTime: rejoinBlackTime, lastMoveAt: game.lastMoveAt, chatMessages: game.chatMessages || [], ...(game.tournamentId ? { tournamentId: game.tournamentId, tournamentName: game.tournamentName, isInterclub: !!game.isInterclub, firstMoveDeadline: game.firstMoveDeadline } : {}) });
        if (!game._board) { game._board = serverChess.rebuildBoard(game.moves); }
        break;
      }
    }
  });

  socket.on('join_tournament_room',  (tid) => { socket.join(`tournament_${tid}`); const t = tournaments.find(t => t.id === tid); if (t) socket.emit('tournament_update', sanitizeTournament(t)); });
  socket.on('leave_tournament_room', (tid) => socket.leave(`tournament_${tid}`));

  socket.on('tournament_seek', (tournamentId) => {
    if (!socket.username) return;
    const t = tournaments.find(t => t.id === tournamentId);
    if (!t || getTournamentStatus(t, Date.now()) !== 'active') return socket.emit('error', 'Турнир не активен');
    const p = t.participants.find(p => p.username === socket.username);
    if (!p) return socket.emit('error', 'Вы не участвуете');
    if (p.currentGameId) return;
    if (p.waiting && !p.paused) return;
    // 2) Троттлинг: не чаще раза в секунду на сокет.
    const nowTs = Date.now();
    if (socket._lastSeekAt && nowTs - socket._lastSeekAt < 1000) return;
    socket._lastSeekAt = nowTs;
    p.waiting = true;
    p.paused = false;
    p.nextEligibleAt = 0; // явный клик "Играть" — грейс-период не нужен
    saveTournament(t).catch(() => {});
    io.to(`tournament_${t.id}`).emit('tournament_update', sanitizeTournament(t));
    tryPairTournamentPlayers(t);
  });

  socket.on('tournament_unseek', (tournamentId) => {
    if (!socket.username) return;
    const t = tournaments.find(t => t.id === tournamentId);
    if (!t) return;
    const p = t.participants.find(p => p.username === socket.username);
    if (p) { p.waiting = false; p.paused = true; saveTournament(t).catch(() => {}); io.to(`tournament_${t.id}`).emit('tournament_update', sanitizeTournament(t)); }
  });

  socket.on('tournament_rejoin', ({ tournamentId, gameId }) => {
    if (!socket.username) return;
    const t = tournaments.find(t => t.id === tournamentId);
    if (!t) return;
    const p = t.participants.find(p => p.username === socket.username);
    if (!p || p.currentGameId !== gameId) return;
    const game = activeGames.get(gameId);
    if (!game) return;
    const color = game.white === socket.username ? 'white' : 'black';
    const opponent = color === 'white' ? game.black : game.white;
    const oppRating = usersCache.get(opponent.toLowerCase())?.rating ?? '?';
    let rejoinWhiteTime = game.whiteTime, rejoinBlackTime = game.blackTime;
    if (game.lastMoveAt !== null && rejoinWhiteTime !== undefined) {
      const elapsedSince = (Date.now() - game.lastMoveAt) / 1000;
      if (game.turn === 'white') rejoinWhiteTime = Math.max(0, rejoinWhiteTime - elapsedSince);
      else                       rejoinBlackTime = Math.max(0, rejoinBlackTime - elapsedSince);
    }
    socket.emit('game_start', { gameId, color, opponent, opponentRating: oppRating, timeControl: game.timeControl, moves: game.moves, whiteTime: rejoinWhiteTime, blackTime: rejoinBlackTime, lastMoveAt: game.lastMoveAt, chatMessages: game.chatMessages || [], ...(game.tournamentId ? { tournamentId: game.tournamentId, tournamentName: game.tournamentName, isInterclub: !!game.isInterclub, firstMoveDeadline: game.firstMoveDeadline } : {}) });
  });

  socket.on('tournament_waiting', ({ tournamentId }) => {
    const t = tournaments.find(t => t.id === tournamentId);
    if (!t || !socket.username) return;
    const p = t.participants.find(p => p.username === socket.username);
    if (!p || p.left || p.anticheatBanned || p.currentGameId) return;
    if (getTournamentStatus(t, Date.now()) !== 'active') return;
    if (p.waiting && !p.paused) return;
    const nowTs = Date.now();
    if (socket._lastSeekAt && nowTs - socket._lastSeekAt < 1000) return;
    socket._lastSeekAt = nowTs;
    p.waiting = true;
    p.paused = false;
    p.nextEligibleAt = 0; // явный клик "Играть" — грейс-период не нужен
    saveTournament(t).catch(() => {});
    io.to(`tournament_${t.id}`).emit('tournament_update', sanitizeTournament(t));
    tryPairTournamentPlayers(t);
    // Повторная попытка спаривания через 1.5 сек — на случай если второй игрок ещё не вошёл в очередь
    setTimeout(() => tryPairTournamentPlayers(t), 1500);
  });

  socket.on('tournament_berserk', ({ gameId }) => {
    if (!socket.username) return;
    const game = tournamentGames.get(gameId); if (!game) return;
    // Безопасность: берсерк может включить ТОЛЬКО участник партии и только
    if (game.white !== socket.username && game.black !== socket.username) return;
    const color = game.white === socket.username ? 'white' : 'black';
    if (game.berserk[color] || game.moveCounts[color] > 0) return;
    game.berserk[color] = true;
    if (color === 'white') {
      game.whiteTime = Math.floor((game.whiteTime || 0) / 2);
    } else {
      game.blackTime = Math.floor((game.blackTime || 0) / 2);
    }
    game.tcIncrement = 0;
    game.lastMoveAt = game.lastMoveAt || Date.now();
    const payload = { gameId, color, berserk: game.berserk, whiteTime: game.whiteTime, blackTime: game.blackTime };
    [findSocketByUsername(game.white), findSocketByUsername(game.black)].forEach(s => s?.emit('berserk_activated', payload));
  });

  // Формат контрольного времени «10+0», «3+2», «60+0s» (для пулов) —
  const TIME_CONTROL_RE = /^\d{1,3}(\.\d)?s?\+\d{1,2}s?$/;

  socket.on('post_challenge', (data) => {
    if (!socket.username) return;
    if (typeof data !== 'object' || data === null) return;
    const nowTs = Date.now();
    if (socket._lastPostChallengeAt && nowTs - socket._lastPostChallengeAt < 1000) {
      return socket.emit('error', 'Слишком часто — подождите секунду');
    }
    socket._lastPostChallengeAt = nowTs;
    const timeControl = typeof data.timeControl === 'string' && TIME_CONTROL_RE.test(data.timeControl) ? data.timeControl : '10+0';
    const color = ['white', 'black', 'random'].includes(data.color) ? data.color : 'random';
    const rated = data.rated !== false;
    const challenge = { id: uuidv4(), from: socket.username, timeControl, color, rated, createdAt: Date.now(), socketId: socket.id };
    const idx = pendingChallenges.findIndex(c => c.from === socket.username);
    if (idx !== -1) pendingChallenges.splice(idx, 1);
    pendingChallenges.push(challenge);
    io.emit('challenges_update', pendingChallenges.filter(c => Date.now() - c.createdAt < CHALLENGE_TTL_MS));
  });

  socket.on('cancel_challenge', () => {
    if (!socket.username) return;
    const idx = pendingChallenges.findIndex(c => c.from === socket.username);
    if (idx === -1) return;
    pendingChallenges.splice(idx, 1);
    io.emit('challenges_update', pendingChallenges.filter(c => Date.now() - c.createdAt < CHALLENGE_TTL_MS));
  });

  socket.on('accept_challenge', (challengeId) => {
    if (!socket.username) return;
    const idx = pendingChallenges.findIndex(c => c.id === challengeId);
    if (idx === -1) return socket.emit('error', 'Вызов не найден');
    const challenge = pendingChallenges[idx];
    if (challenge.from === socket.username) return socket.emit('error', 'Нельзя принять свой вызов');
    if (Date.now() - challenge.createdAt > CHALLENGE_TTL_MS) {
      pendingChallenges.splice(idx, 1);
      io.emit('challenges_update', pendingChallenges);
      return socket.emit('error', 'Вызов устарел');
    }
    pendingChallenges.splice(idx, 1);
    io.emit('challenges_update', pendingChallenges.filter(c => Date.now() - c.createdAt < CHALLENGE_TTL_MS));
    setTimeout(() => startGame(socket, challenge), 50);
  });

  socket.on('challenge_user', (data) => {
    if (!socket.username) return;
    const now = Date.now();
    if (socket._lastDirectChallengeAt && now - socket._lastDirectChallengeAt < 2000) {
      return socket.emit('error', 'Не так часто — подождите пару секунд');
    }
    socket._lastDirectChallengeAt = now;
    // Поддерживаем и старый формат вызова (просто ник строкой), и новый
    // объект { username, rated } — чтобы можно было выбрать товарищескую партию.
    const targetUsername = typeof data === 'string' ? data : data?.username;
    const rated = typeof data === 'string' ? true : data?.rated !== false;
    if (typeof targetUsername !== 'string' || !targetUsername || targetUsername.length > 20) return;
    if (targetUsername.toLowerCase() === socket.username.toLowerCase()) return socket.emit('error', 'Нельзя вызвать самого себя');
    const t = findSocketByUsername(targetUsername);
    if (!t) return socket.emit('error', 'Не в сети');
    // Контроль времени личного вызова: берём выбранный в зале, иначе 10+0.
    const directTC = typeof data === 'object' && data && typeof data.timeControl === 'string' && TIME_CONTROL_RE.test(data.timeControl) ? data.timeControl : '10+0';
    socket._directTC = directTC;
    socket._directRated = rated;
    t.emit('incoming_challenge', { from: socket.username, socketId: socket.id, rated, timeControl: directTC });
  });

  socket.on('accept_direct_challenge', (data) => {
    if (!socket.username) return;
    const fromSocketId = typeof data === 'string' ? data : data?.fromSocketId;
    const rated = typeof data === 'string' ? true : data?.rated !== false;
    const fromSocket = io.sockets.sockets.get(fromSocketId);
    if (!fromSocket) return socket.emit('error', 'Игрок отключился');
    // Берём контроль, который вызывающий сам указал (хранится на сервере, клиенту не доверяем).
    const directTC = typeof fromSocket._directTC === 'string' && TIME_CONTROL_RE.test(fromSocket._directTC) ? fromSocket._directTC : '10+0';
    const effectiveRated = typeof fromSocket._directRated === 'boolean' ? fromSocket._directRated : rated;
    startGame(socket, { from: fromSocket.username, timeControl: directTC, color: 'random', rated: effectiveRated, socketId: fromSocketId });
  });

  socket.on('decline_challenge', (fromSocketId) => {
    if (!socket.username) return;
    if (typeof fromSocketId !== 'string' || fromSocketId.length > 64) return;
    const fs = io.sockets.sockets.get(fromSocketId);
    if (fs) fs.emit('challenge_declined', socket.username);
  });

  socket.on('rejoin_game', ({ gameId }) => {
    if (!socket.username) return;
    const game = activeGames.get(gameId);
    if (!game || (game.white !== socket.username && game.black !== socket.username)) return;
    game._board = serverChess.rebuildBoard(game.moves);
    socket.emit('rejoin_ack', { gameId, moves: game.moves, turn: game.turn, whiteTime: game.whiteTime, blackTime: game.blackTime, chatMessages: game.chatMessages || [] });
  });

  socket.on('make_move', ({ gameId, move }) => {
    if (!socket.username) return;
    const game = activeGames.get(gameId);
    if (!game) { socket.emit('error', 'Партия не найдена (возможно, уже завершилась)'); return; }
    if (typeof move !== 'object' || move === null || typeof move.from !== 'number' || typeof move.to !== 'number'
        || move.from < 0 || move.from > 63 || move.to < 0 || move.to > 63) {
      socket.emit('move_rejected', { gameId, reason: 'invalid' });
      return;
    }
    if (move.promotion != null && !['q', 'r', 'b', 'n'].includes(move.promotion)) {
      socket.emit('move_rejected', { gameId, reason: 'invalid' });
      return;
    }
    if (game.white !== socket.username && game.black !== socket.username) return;
    const pc = game.white === socket.username ? 'white' : 'black';
    if (game.turn !== pc) {
      socket.emit('move_rejected', {
        gameId, reason: 'not-your-turn',
        moves: game.moves, whiteTime: game.whiteTime, blackTime: game.blackTime, lastMoveAt: game.lastMoveAt,
      });
      return;
    }
    if (game._board) {
      const moveObj = { from: move.from, to: move.to, promotion: move.promotion || null };
      if (!serverChess.isLegalMove(game._board, moveObj)) {
        const rebuilt = serverChess.rebuildBoard(game.moves);
        if (!serverChess.isLegalMove(rebuilt, moveObj)) {
          socket.emit('move_rejected', {
            gameId, reason: 'illegal-move',
            moves: game.moves, whiteTime: game.whiteTime, blackTime: game.blackTime, lastMoveAt: game.lastMoveAt,
          });
          return;
        }
        game._board = rebuilt;
        console.warn(`[make_move] Ресинхронизация доски для игры ${gameId} (игрок: ${socket.username})`);
      }
      try { const found = serverChess.findMove(game._board, moveObj); game._board = serverChess.applyMove(game._board, found); } catch (e) { console.warn('[make_move] applyMove error:', e); }
    }
    const now = Date.now();
    if (game.lastMoveAt !== null && game.whiteTime !== undefined) {
      const elapsed = (now - game.lastMoveAt) / 1000;
      if (pc === 'white') game.whiteTime = Math.max(0, game.whiteTime - elapsed + (game.tcIncrement || 0));
      else                game.blackTime = Math.max(0, game.blackTime - elapsed + (game.tcIncrement || 0));
    }
    if (!game._acMoveTimes)  game._acMoveTimes = { white: [], black: [] };
    if (!game._acSuspect)    game._acSuspect   = { white: 0, black: 0 };
    if (game._acLastMoveAt && game.moves.length > 4) {
      const moveMs = now - game._acLastMoveAt;
      const times = game._acMoveTimes[pc]; times.push(moveMs); if (times.length > 20) times.shift();
      if (times.length >= 10) {
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        if (avg < 900 && times.every(t => t < 1200)) {
          game._acSuspect[pc]++;
          if (game._acSuspect[pc] >= 3) {
            emitToAdmins('anticheat_alert', { username: socket.username, gameId, avgMs: Math.round(avg), suspectLevel: game._acSuspect[pc], message: `🚨 Возможный движок: ${socket.username} (avg ${Math.round(avg)}ms/ход)` }).catch(() => {});
          }
        } else if (avg > 3000) { game._acSuspect[pc] = Math.max(0, game._acSuspect[pc] - 1); }
      }
    }
    game._acLastMoveAt = now;
    game.lastMoveAt = now;
    game.moves.push(move); game.turn = game.turn === 'white' ? 'black' : 'white'; game.lastActivity = now;
    if (game.moveCounts) game.moveCounts[pc] = (game.moveCounts[pc] || 0) + 1;
    if (game.firstMoveDeadline) {
      if (game.moves.length === 1) {
        // Белые сделали первый ход — даём чёрным отдельные 20 сек на их первый ход
        game.firstMoveDeadline = now + FIRST_MOVE_TIMEOUT;
      } else if (game.moves.length === 2) {
        // Чёрные тоже сходили первый раз — таймер первого хода больше не нужен
        game.firstMoveDeadline = null;
      }
    }
    const other = findSocketByUsername(pc === 'white' ? game.black : game.white);
    const timePayload = { move, gameId, whiteTime: game.whiteTime, blackTime: game.blackTime, serverAt: now, firstMoveDeadline: game.firstMoveDeadline };
    socket.emit('move_confirmed', timePayload);
    if (other) other.emit('opponent_move', timePayload);
  });

  socket.on('game_over', async ({ gameId, result, reason, accuracy }) => {
    if (!socket.username) return;
    const game = activeGames.get(gameId); if (!game) return;
    // Игрок должен быть участником этой партии, чтобы вообще заявлять об её завершении
    if (socket.username !== game.white && socket.username !== game.black) return;

    if (reason === 'timeout' || reason === 'flag') {
      socket.emit('error', 'Таймаут определяется сервером');
      return;
    }

    const ALLOWED_REASONS = ['checkmate', 'stalemate', 'threefold-repetition', 'fifty-move', 'insufficient-material'];
    if (!ALLOWED_REASONS.includes(reason)) { socket.emit('error', 'Недопустимая причина завершения'); return; }

    const norm = result === 'w' ? 'white' : result === 'b' ? 'black' : result;
    if (norm !== 'white' && norm !== 'black' && norm !== 'draw') return;

    // ── Мат/пат — проверяем по реальной позиции на сервере, а не
    // просто принимаем то, что прислал клиент.
    if (reason === 'checkmate' || reason === 'stalemate') {
      const board = game._board || serverChess.rebuildBoard(game.moves);
      const boardTurnColor = board.turn === 'w' ? 'white' : 'black';
      if (reason === 'checkmate') {
        if (!serverChess.isCheckmate(board)) { socket.emit('error', 'Мат не подтверждён сервером'); return; }
        const expectedWinner = boardTurnColor === 'white' ? 'black' : 'white';
        if (norm !== expectedWinner) { socket.emit('error', 'Некорректный результат мата'); return; }
      } else {
        if (!serverChess.isStalemate(board)) { socket.emit('error', 'Пат не подтверждён сервером'); return; }
        if (norm !== 'draw') { socket.emit('error', 'Некорректный результат пата'); return; }
      }
    }

    // ── Ничьи по правилам (50 ходов / недостаток материала / троекратное
    // повторение позиции) — тоже перепроверяем по истории ходов, а не
    // просто верим клиенту.
    if (reason === 'threefold-repetition' || reason === 'fifty-move' || reason === 'insufficient-material') {
      if (norm !== 'draw') { socket.emit('error', 'Некорректный результат ничьей'); return; }
      if (reason === 'threefold-repetition' && !serverChess.isThreefoldRepetition(game.moves)) {
        socket.emit('error', 'Повторение позиции не подтверждено сервером'); return;
      }
      if (reason === 'fifty-move' && !serverChess.isFiftyMoveRule(game.moves)) {
        socket.emit('error', 'Правило 50 ходов не подтверждено сервером'); return;
      }
      if (reason === 'insufficient-material') {
        const board = game._board || serverChess.rebuildBoard(game.moves);
        if (!serverChess.isInsufficientMaterial(board.squares)) {
          socket.emit('error', 'Недостаток материала не подтверждён сервером'); return;
        }
      }
    }

    // Удаляем сразу — чтобы второй клиент не мог вызвать game_over дважды на ту же игру.
    // Accuracy: принимаем только числа в диапазоне 0..100 и только по известным ключам.
    if (accuracy && typeof accuracy === 'object') {
      const safe = {};
      for (const key of ['white', 'black']) {
        const v = Number(accuracy[key]);
        if (Number.isFinite(v)) safe[key] = Math.max(0, Math.min(100, v));
      }
      if (Object.keys(safe).length) game.accuracy = safe;
    }
    await endGameAuthoritative(gameId, game, norm, reason);
  });

  socket.on('resign', async ({ gameId }) => {
    if (!socket.username) return;
    const game = activeGames.get(gameId); if (!game) return;
    if (game.white !== socket.username && game.black !== socket.username) return;
    // Двойной учёт (P1, устранено): хендлер больше не завершает партию сам
    // (свой delete из карт + recordGame + updateStats + finishTournamentGame),
    // а передаёт всё в единую авторитарную точку endGameAuthoritative — как
    // уже делают game_over и серверный тик часов. Она защищена флагом
    // _finishing от гонки с параллельным resign/timeout/game_over и
    // гарантирует ровно один финал: одна запись в БД, один инкремент
    // статистики, одни очки турнира, одно broadcast game_ended.
    const winner = game.white === socket.username ? 'black' : 'white';
    await endGameAuthoritative(gameId, game, winner, 'resign');
  });

  socket.on('offer_draw', ({ gameId }) => {
    if (!socket.username) return;
    const game = activeGames.get(gameId); if (!game) return;
    if (game.white !== socket.username && game.black !== socket.username) return;
    const nowD = Date.now();
    if (socket._lastDrawOfferAt && nowD - socket._lastDrawOfferAt < 2000) {
      return socket.emit('error', 'Не так часто — подождите пару секунд');
    }
    socket._lastDrawOfferAt = nowD;
    const opp = game.white === socket.username ? game.black : game.white;
    const os = findSocketByUsername(opp); if (os) os.emit('draw_offered', { gameId, from: socket.username });
  });

  socket.on('accept_draw', async ({ gameId }) => {
    if (!socket.username) return;
    const game = activeGames.get(gameId); if (!game) return;
    if (game.white !== socket.username && game.black !== socket.username) return;
    // Двойной учёт (P1, устранено): завершение — только через единую
    // авторитарную точку endGameAuthoritative (см. resign выше).
    await endGameAuthoritative(gameId, game, 'draw', 'agreement');
  });

  socket.on('game_chat', ({ gameId, message }) => {
    if (!socket.username) return socket.emit('error', 'Сначала войдите в аккаунт');
    const game = activeGames.get(gameId);
    if (!game) return socket.emit('error', 'Партия не найдена (чат недоступен)');
    if (game.white !== socket.username && game.black !== socket.username) return;
    const text = (typeof message === 'string' ? message : '').trim().slice(0, 300); if (!text) return;
    const opp = game.white === socket.username ? game.black : game.white;
    const msg = { from: socket.username, message: text, gameId, ts: Date.now() };
    if (!game.chatMessages) game.chatMessages = [];
    game.chatMessages.push(msg);
    if (game.chatMessages.length > 100) game.chatMessages.shift();
    socket.emit('game_chat', msg);
    const os = findSocketByUsername(opp); if (os) os.emit('game_chat', msg);
  });

  socket.on('join_club_room', (clubId) => {
    if (!socket.username) return;
    const club = clubs.find(c => c.id === clubId);
    if (!club) return;
    if (!canWriteInClubChat(club, socket.username) && !isClubModerator(club, socket.username)) return;
    socket.join('club_' + clubId);
  });

  socket.on('leave_club_room', (clubId) => { socket.leave('club_' + clubId); });

// ── Фильтр глобального чата ─────────────────────────────────────
// Та же логика, что уже используется на клиенте (app.js:containsBadWords).
const MAT_WORDS_CHAT = [
  'блять','блядь','бля','пиздец','пизда','пизду','пизды',
  'сука','сучка','хуй','хуе','хер',
  'ебать','ебал','ебан','ебаный','ебло','еблан','ебуч','заеб','выеб',
  'нахуй','нахер','похуй','похер',
  'гандон','долбоеб','долбоёб','далбаеб','далбоеб','далбоёб','мудак',
  'шлюха','шлюх','шалава','проститутка',
  'соси','сосать','отсоси','сраный','обосранный','пздц',
  'fuck','fucking','bitch','asshole','dick','shit',
];
// Спам/казино/ссылки — тут по-прежнему ищем максимально агрессивно (в
// одну сплошную строку без пробелов). Заодно почистил два "мёртвых"
// слова из старого списка — "договорноймatch" и "легкиеdeньги" — там
// была опечатка вперемешку кириллицы с латиницей, из-за которой они
// физически не могли ни с чем совпасть.
const SPAM_WORDS_CHAT = [
  'казино','casino','ставки','ставка','bet','букмекер',
  '1xbet','melbet','parimatch','fonbet','aviator',
  'выигрыш','джекпот','бонус','промокод','депозит','фриспины','free spin',
  'прогноз','договорной матч','легкие деньги',
];
function normalizeChatWord(text) {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/[@]/g, 'a').replace(/[0]/g, 'o')
    .replace(/[3]/g, 'e').replace(/[1!]/g, 'i').replace(/9/g, 'я').replace(/6/g, 'б').replace(/4/g, 'ч');
}
function normalizeChatCollapsed(text) {
  return normalizeChatWord(text).replace(/\s+/g, '').replace(/[^a-zа-я0-9]/gi, '');
}
function chatMessageHasBadWords(text) {
  const collapsed = normalizeChatCollapsed(text);
  if (SPAM_WORDS_CHAT.some(w => collapsed.includes(normalizeChatCollapsed(w)))) return true;
  // Короткие корни (3 буквы и меньше, типа "бля","хер") ловим ТОЛЬКО как
  // начало слова — иначе поймаем "рубля","сабля","херсон" и подобные ни
  // при чём не виноватые слова. Более длинные однозначные корни ищем
  // где угодно внутри слова — это по-прежнему ловит приставочные формы.
  const tokens = normalizeChatWord(text).replace(/[^a-zа-я0-9\s]/gi, '').split(/\s+/).filter(Boolean);
  return MAT_WORDS_CHAT.some(rawWord => {
    const word = normalizeChatWord(rawWord).replace(/[^a-zа-я0-9]/gi, '');
    if (!word) return false;
    // "хер" отдельно — только точное совпадение слова целиком, иначе
    // ловит "Херсон", "херувим" и подобные ни при чём не виноватые слова.
    if (word === 'хер') return tokens.includes(word);
    if (word.length <= 3) return tokens.some(t => t.startsWith(word));
    return tokens.some(t => t.includes(word));
  });
}

  socket.on('global_chat', async ({ message }) => {
    if (!socket.username) return;
    const text = (typeof message === 'string' ? message : '').trim().slice(0, 300); if (!text) return;
    const now = Date.now();

    // ── Анти-спам-счётчики проверяем СИНХРОННО и ДО await getUser.
    if (!socket._chatMsgs) socket._chatMsgs = [];
    socket._chatMsgs = socket._chatMsgs.filter(t => now - t < 10000); socket._chatMsgs.push(now);
    if (socket._chatMsgs.length > 10) { socket.emit('error', 'Вы временно отключены за спам в чате'); socket.disconnect(); return; }
    if (socket._chatMsgs.length > 5) { socket.emit('error', 'Слишком много сообщений. Притормози!'); return; }
    if (socket._lastChatAt && now - socket._lastChatAt < 1500) { socket.emit('error', 'Не так быстро!'); return; }
    socket._lastChatAt = now;

    const user = await getUser(socket.username.toLowerCase());
    if (!user || user.banned) { socket.emit('auth_error', 'Сессия недействительна'); socket.disconnect(); return; }

    if (global.chatBans) {
      const unbanAt = global.chatBans.get(socket.username.toLowerCase());
      if (unbanAt && unbanAt > now) {
        const minsLeft = Math.ceil((unbanAt - now) / 60000);
        socket.emit('error', `Вы забанены в чате ещё ${minsLeft} мин. Читайте правила платформы.`);
        return;
      } else if (unbanAt) { global.chatBans.delete(socket.username.toLowerCase()); }
    }

    const chatHardBan = async (reason) => {
      console.warn(`[ChatHardBan] ${socket.username} — ${reason}`);
      try {
        if (user.createdDeviceId) { bannedDevices.add(user.createdDeviceId); await saveBanToDB(null, user.createdDeviceId); }
        user.banned = true; user.banReason = reason; await saveUser(user);
        await removeUserChatMessages(socket.username);
      } catch (e) {
        // Даже если БД недоступна — блокируем сокет и помечаем юзера в памяти:
        // бан не должен «отменяться» из-за сбоя хранилища.
        console.error('[ChatHardBan] DB error:', e.message);
        usersCache.set(socket.username.toLowerCase(), user);
      }
      socket.emit('error', 'Заблокирован навсегда: ' + reason); socket.disconnect();
    };

    const textLow = text.toLowerCase().replace(/[:/.\-\s]/g, '');
    const LINK_TRIGGERS = ['http','https','www','tme','discordgg','vkcom','instagramcom','tiktokcom'];
    if (LINK_TRIGGERS.some(t => textLow.includes(t))) { await chatHardBan('Реклама/ссылки в чате'); return; }

    if (chatMessageHasBadWords(text)) { await chatHardBan('Нарушение правил чата (запрещённые слова)'); return; }

    if (socket._lastChatMsg === text) {
      socket._dupCount = (socket._dupCount || 0) + 1;
      if (socket._dupCount >= 3) { await chatHardBan('Автобан: флуд (дублирование)'); return; }
      socket.emit('error', 'Не повторяйся'); return;
    }
    socket._lastChatMsg = text; socket._dupCount = 0;
    moderation.record({ username: socket.username, channel: 'global-chat', text });

    const msg = { id: uuidv4(), username: socket.username, message: text, role: user?.role === 'admin' ? 'admin' : 'user', timestamp: now, emoji: user.emoji || '', vip: isVip(user) };

    if (user.shadowBanned) {
      msg.shadowHidden = true;
      globalChat.push(msg); if (globalChat.length > 500) globalChat.shift();
      socket.emit('global_chat', msg);
      emitToAdmins('global_chat', msg).catch(() => {});
      try { await saveChatMsg(msg); } catch (e) { console.error('[Chat save]', e.message); }
      return;
    }

    globalChat.push(msg); if (globalChat.length > 500) globalChat.shift();
    io.emit('global_chat', msg);
    // Сообщение сохраняем в БД ДО/параллельно с рассылкой и await'им: иначе при
    // падении БД сообщение уже разошлось в реальном времени, но в историю не
    // попало — после рестарта сервера «исчезает» из загруженной истории.
    try { await saveChatMsg(msg); } catch (e) { console.error('[Chat save]', e.message); }
  });

  socket.on('disconnect', () => {
    const sess = sessions.get(socket.id);
    if (sess) {
      sessions.delete(socket.id);
      // Multi-socket: убираем только ЭТОТ сокет из набора юзера; онлайн-счётчик
      // уменьшаем, лишь когда у юзера не осталось ни одного сокета.
      const low = sess.username.toLowerCase();
      const ids = usernameToSocketId.get(low);
      if (ids) {
        ids.delete(socket.id);
        if (ids.size === 0) {
          usernameToSocketId.delete(low);
          onlineUsers.delete(sess.username);
        }
      } else {
        onlineUsers.delete(sess.username);
      }
      // Турнирную паузу/возврат в очередь делаем ТОЛЬКО если у юзера не
      // осталось других живых сокетов (multi-socket): отключение DM-сокета
      // header.js не должно снимать игрока с очереди поиска партии.
      const userStillOnline = usernameToSocketId.has(sess.username.toLowerCase());
      if (!userStillOnline) {
        io.emit('online_count', onlineUsers.size);
        for (const t of tournaments) {
        const p = t.participants.find(p => p.username === sess.username);
        if (p && p.waiting && !p.left && !p.anticheatBanned && !p.currentGameId) {
          p._resumeOnReconnect = true;
        }
        if (p) p.waiting = false;
      }
      }
    }
  });
});