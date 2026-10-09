// ═══════════════════════════════════════════════════════════════
//  utils.js — серверные хелперы общего назначения
// ═══════════════════════════════════════════════════════════════
//  Единая серверная реализация экранирования HTML.
//  Используется роутами, которые рендерят HTML на сервере
//  (например, страница партии /game/:gameId в routes.js).
//  Клиентский аналог — public/js/utils.js.
// ═══════════════════════════════════════════════════════════════

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

module.exports = { escapeHtml };
