// ═══════════════════════════════════════════════════════════════
//  db.js — подключение к PostgreSQL (пул) и хелперы запросов
// ═══════════════════════════════════════════════════════════════
//  Единственное место, где создаётся пул соединений. core.js,
//  routes.js и сервисы импортируют отсюда один и тот же pool/db —
//  состояние по-настоящему общее, это НЕ копии.
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();

const { Pool } = require('pg');


// ── Пул соединений ────────────────────────────────────────────
// Размер пула рассчитан на онлайн-платформу (дефолт pg = 10 не выдерживает
// пики одновременных запросов):
//   max                      — до 30 одновременных соединений;
//   idleTimeoutMillis        — простаивающие соединения закрываются через 30с;
//   connectionTimeoutMillis  — если свободного соединения нет 5с, запрос
//                              падает с явной ошибкой вместо бесконечного
//                              ожидания (защита от каскадных зависаний).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 30,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});


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


module.exports = { pool, db, withTransaction };
