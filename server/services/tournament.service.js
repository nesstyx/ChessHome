// ═══════════════════════════════════════════════════════════════
//  services/tournament.service.js — турниры: состояние, пары, часы
// ═══════════════════════════════════════════════════════════════
//  Список турниров, персистентность, жеребьёвка (tryPairTournamentPlayers),
//  турнирные партии и их финалы, межклубные команды, античит-компенсации
//  и 3-секундный тик обслуживания.
//  Доступ к общим объектам (io, usersCache, clubs, findSocketByUsername)
//  — ленивый через require('../core') и require('./game.service').
// ═══════════════════════════════════════════════════════════════

const { db } = require('../db');

const gameService = require('./game.service');


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


// ── Межклубные турниры ────────────────────────────────────────
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
  const core = require('../core');
  const arr = Array.isArray(rawLinks) ? rawLinks : [];
  const teamIds = [];
  const notFound = [];
  const seen = new Set();
  for (const raw of arr) {
    const id = extractClubIdFromLink(raw);
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const club = core.clubs.find(c => c.id === id);
    if (!club) { notFound.push(String(raw)); continue; }
    teamIds.push(club.id);
  }
  return { teamIds, notFound };
}


function getTournamentStatus(t, now) {
  if (now < t.startsAt) return 'upcoming';
  if (now < t.endsAt)   return 'active';
  return 'finished';
}


// Инфо о командах межклубного турнира (id/название/число участников клуба) —
// нужно фронту для выбора команды и отображения турнирной сетки/составов.
function getInterclubTeamsInfo(t) {
  const core = require('../core');
  if (!t.isInterclub) return undefined;
  return (t.teamIds || [])
    .map(id => core.clubs.find(c => c.id === id))
    .filter(Boolean)
    .map(c => ({ id: c.id, name: c.name, memberCount: c.memberCount || (c.members || []).length }));
}


// Командный зачёт межклубного турнира: суммируем очки/результаты всех игроков
// каждой команды среди участников турнира (бан по читерству — не учитываем).
function computeTeamStandings(t) {
  if (!t.isInterclub) return undefined;
  const core = require('../core');
  const byTeam = new Map();
  for (const id of (t.teamIds || [])) {
    const club = core.clubs.find(c => c.id === id);
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
  const core = require('../core');
  const sorted = [...(t.participants || [])].filter(p => !p.anticheatBanned).sort((a, b) => b.score - a.score || b.wins - a.wins);
  return { ...t, participants: sorted, blacklist: undefined, status: getTournamentStatus(t, Date.now()), createdByIsAdmin: core.usersCache.get((t.createdBy || '').toLowerCase())?.role === 'admin', teams: getInterclubTeamsInfo(t), teamStandings: computeTeamStandings(t) };
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


// Время на первый ход в турнирной партии — общее для белых и чёрных
// (после хода белых чёрным даётся такой же дедлайн на их первый ход).
const FIRST_MOVE_TIMEOUT = 20 * 1000;

function startTournamentGame(tournament, p1, p2) {
  const core = require('../core');
  const gameId = core.uuidv4();
  const p1Last = [...tournament.games].reverse().find(g => g.white === p1.username || g.black === p1.username);
  let white, black;
  if (!p1Last || p1Last.black === p1.username) { white = p1.username; black = p2.username; }
  else { white = p2.username; black = p1.username; }
  const wR = core.usersCache.get(white.toLowerCase())?.rating ?? '?';
  const bR = core.usersCache.get(black.toLowerCase())?.rating ?? '?';
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
    _board: gameService.serverChess.startBoard(),
    firstMoveDeadline: now + FIRST_MOVE_TIMEOUT,
    isInterclub: !!tournament.isInterclub,
  };
  gameService.activeGames.set(gameId, game);
  gameService.tournamentGames.set(gameId, game);
  p1.currentGameId = gameId; p2.currentGameId = gameId;
  const payload = (color, opp, oppRating) => ({
    gameId, color, opponent: opp, opponentRating: oppRating,
    timeControl: tournament.timeControl,
    tournamentId: tournament.id, tournamentName: tournament.name,
    isInterclub: !!tournament.isInterclub,
    firstMoveDeadline: game.firstMoveDeadline,
    // Синхронизация часов: отдаём момент начала отсчёта (lastMoveAt)
    // и серверное "сейчас", чтобы клиентский таймер шёл синхронно
    // с серверным liveClock с самой первой секунды.
    serverAt: now, lastMoveAt: game.lastMoveAt, whiteTime: game.whiteTime, blackTime: game.blackTime,
  });
  const ws = core.findSocketByUsername(white);
  const bs = core.findSocketByUsername(black);
  if (ws) ws.emit('game_start', payload('white', black, bR));
  if (bs) bs.emit('game_start', payload('black', white, wR));
  saveTournament(tournament).catch(() => {});
  core.io.to(`tournament_${tournament.id}`).emit('tournament_update', sanitizeTournament(tournament));
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
  if (gameService.hasFullMove(game)) {
    await gameService.recordGame(game, result, reason);
    await gameService.updateStats(game.white, game.black, result);
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
  const core = require('../core');
  if (wp && !wp.left && !wp.anticheatBanned && now < tournament.endsAt) {
    if (afkColor === 'white') { wp.waiting = false; wp.paused = true; wp.nextEligibleAt = 0; }
    else { wp.waiting = true; wp.paused = false; wp.nextEligibleAt = nextEligibleAt; }
  }
  if (bp && !bp.left && !bp.anticheatBanned && now < tournament.endsAt) {
    if (afkColor === 'black') { bp.waiting = false; bp.paused = true; bp.nextEligibleAt = 0; }
    else { bp.waiting = true; bp.paused = false; bp.nextEligibleAt = nextEligibleAt; }
  }
  await saveTournament(tournament);
  core.io.to(`tournament_${tournament.id}`).emit('tournament_update', sanitizeTournament(tournament));
  // Первая попытка — заспарит других игроков, у которых грейс-период уже истёк
  // или которых не касался (например "bye"-игрок, ждавший своей очереди).
  setTimeout(() => tryPairTournamentPlayers(tournament), 500);
  // Вторая попытка — уже после того, как грейс-период для только что
  // освободившихся игроков истечёт (если они сами не поставили паузу).
  setTimeout(() => tryPairTournamentPlayers(tournament), REMATCH_GRACE_PERIOD + 500);
}


// Пересчёт очков и компенсаций при бане читера: его результаты аннулируются,
// а пострадавшим соперникам возвращаются победы.
function anticheatBan(tournament, username) {
  const core = require('../core');
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
      const s = core.findSocketByUsername(oppName);
      if (s) s.emit('anticheat_compensation', { message: `${username} забанен за читы. Ваше поражение аннулировано (+2 очка)!`, tournamentId: tournament.id });
    } else if (bannedDraw) {
      // За ничью сопернику дают +1 очко компенсации
      opp.score = Math.max(0, opp.score - 1); // убираем очко ничьей
      opp.draws = Math.max(0, opp.draws - 1);
      opp.wins++; opp.score += 2; // засчитываем победу
      compensated++;
      const s = core.findSocketByUsername(oppName);
      if (s) s.emit('anticheat_compensation', { message: `${username} забанен за читы. Ваша ничья переведена в победу (+1 очко)!`, tournamentId: tournament.id });
    }
  }
  core.io.to(`tournament_${tournament.id}`).emit('anticheat_ban', { username, tournamentId: tournament.id, tournamentName: tournament.name, message: `⚠️ ${username} забанен за использование компьютерной помощи.` });
  const sock = core.findSocketByUsername(username);
  if (sock) sock.emit('tournament_banned', { message: 'Вы заблокированы в этом турнире за использование компьютерной помощи.' });
  saveTournament(tournament).catch(() => {});
}


// Турнирный тик раз в 3 секунды: старт турнира, дедлайны первых ходов
// (timeout_firstmove), жеребьёвка, определение победителя. Тело тика
// обёрнуто в try/catch (issue #91): ошибка БД внутри одного тика не
// должна ронять процесс Node.js необработанным rejection.
setInterval(() => {
  const tick = async () => {
    const core = require('../core');
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
          if (!anyChanged) {
            // Все уже ждут/играют — всё равно сообщаем комнате, что турнир стартовал,
            // иначе страница остаётся на «00:00:00» до ручного обновления.
            core.io.to(`tournament_${t.id}`).emit('tournament_update', sanitizeTournament(t));
          }
          if (anyChanged) {
            await saveTournament(t);
            core.io.to(`tournament_${t.id}`).emit('tournament_update', sanitizeTournament(t));
            // Уведомляем участников о старте
            for (const p of t.participants) {
              if (!p.left && !p.anticheatBanned) {
                const s = core.findSocketByUsername(p.username);
                if (s) s.emit('tournament_started', { tournamentId: t.id, name: t.name });
              }
            }
          }
        }

        for (const [gameId, game] of gameService.tournamentGames.entries()) {
          if (game.tournamentId !== t.id) continue;
          if (game.firstMoveDeadline && now > game.firstMoveDeadline) {
            if (game.moves.length === 0) {
              // Белые не сделали первый ход — поражение белых.
              // Из карт удаляем СИНХРОННО ДО await — иначе параллельный
              // resign/timeout успевает завершить партию второй раз.
              console.log(`[Tournament] Первый ход просрочен: ${game.white} (белые) в игре ${gameId}`);
              gameService.tournamentGames.delete(gameId);
              gameService.activeGames.delete(gameId);
              const ws = core.findSocketByUsername(game.white);
              const bs = core.findSocketByUsername(game.black);
              const payload = { gameId, result: 'black', reason: 'timeout_firstmove' };
              if (ws) ws.emit('game_ended', payload);
              if (bs) bs.emit('game_ended', payload);
              await finishTournamentGame(t, game, 'black', 'timeout_firstmove');
            } else if (game.moves.length === 1) {
              // Белые сходили, чёрные не сделали свой первый ход — поражение чёрных
              console.log(`[Tournament] Первый ход просрочен: ${game.black} (чёрные) в игре ${gameId}`);
              gameService.tournamentGames.delete(gameId);
              gameService.activeGames.delete(gameId);
              const ws = core.findSocketByUsername(game.white);
              const bs = core.findSocketByUsername(game.black);
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
        core.io.to(`tournament_${t.id}`).emit('tournament_finished', { winner: t.winner, tournament: t });
      }
    }
  };
  tick().catch(e => console.error('[Tournament tick]', e));
}, 3000);


// Архив: удаляем турниры, завершённые больше двух лет назад
setInterval(() => {
  const cleanup = async () => {
    const twoYearsAgo = Date.now() - 2 * 365 * 24 * 60 * 60 * 1000;
    for (let i = tournaments.length - 1; i >= 0; i--) {
      const t = tournaments[i];
      if (t.endsAt && t.endsAt < twoYearsAgo) { tournaments.splice(i, 1); await deleteTournamentFromDB(t.id); }
    }
  };
  cleanup().catch(e => console.error('[Tournament cleanup]', e));
}, 24 * 60 * 60 * 1000);


// Object.assign (а не перезапись module.exports): модуль связан циклическим
// require с game.service.js, и при другом порядке загрузки сосед мог бы
// захватить исходный объект exports до присвоения — дополняем именно его.
Object.assign(module.exports, {
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
});
