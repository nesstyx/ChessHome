// ═══════════════════════════════════════════════════════════════
//  utils.js — общие утилиты ChessHome (клиент)
// ═══════════════════════════════════════════════════════════════
//  Единая «библиотечная» реализация escapeHtml (P0, унификация).

'use strict';

/**
 * Экранирует HTML-спецсимволы: & < > " '.
 * Безопасно и для текстового содержимого, и для значений атрибутов.
 * @param {*} str — любое значение; null/undefined дают пустую строку.
 * @returns {string}
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, function (m) {
    switch (m) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default:  return m;
    }
  });
}

// Классический скрипт: function-объявление верхнего уровня и так
// становится глобальной (window.escapeHtml). Экспортируем явно,
// чтобы имя не терялось даже внутри модульных обёрток в будущем.
if (typeof window !== 'undefined') {
  window.escapeHtml = escapeHtml;
  // Алиас: страницы interclub-tournament(s).html исторически вызывают
  // короткое имя escHtml — без него там ReferenceError и вечный прелоадер.
  window.escHtml = escapeHtml;
}

/**
 * Безопасный разбор JSON-ответа fetch (унификация, DRY).
 * Если сервер (например, nginx под нагрузкой) вернул
 * HTML-заглушку 502/503 вместо JSON, res.json() падает с криптичным
 * "unexpected character" — здесь оно превращается в понятную ошибку.
 * @param {Response} res
 * @returns {Promise<any>}
 */
async function safeJson(res) {
  try {
    return await res.json();
  } catch (e) {
    throw new Error('Сервер временно недоступен (HTTP ' + res.status + '). Попробуйте ещё раз через минуту.');
  }
}
if (typeof window !== 'undefined') {
  window.safeJson = safeJson;
}
