// ═══════════════════════════════════════════════════════════════
//  services/chat.service.js — история и хранение сообщений чатов
// ═══════════════════════════════════════════════════════════════
//  Глобальный чат, чаты клубов и турниров: оперативные кэши +
//  синхронизация с БД. Права модерации (isSiteAdmin/canManageTournament
//  и т.п.) остаются в core.js.
// ═══════════════════════════════════════════════════════════════

const { db } = require('../db');


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


// Вынесено в отдельную функцию, чтобы вызывать и из ручного удаления,
// и автоматически при бане пользователя (см. /api/admin/ban).
async function removeUserChatMessages(username) {
  const core = require('../core');
  const toRemove = globalChat.filter(m => m.username === username).map(m => m.id);
  for (let i = globalChat.length - 1; i >= 0; i--) {
    if (globalChat[i].username === username) globalChat.splice(i, 1);
  }
  for (const id of toRemove) {
    await deleteChatMsg(id).catch(() => {});
  }
  if (toRemove.length) core.io.emit('chat_msgs_user_deleted', username);
  return toRemove.length;
}


module.exports = {
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
};
