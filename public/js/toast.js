// ═══════════════════════════════════════════════════════════════
//  toast.js — единые toast-уведомления ChessHome (клиент)
// ═══════════════════════════════════════════════════════════════
//  Единственный компонент уведомлений: контейнер #toast-container
//  создаётся динамически при первом вызове, стили живут в /css/main.css.
//
//  Подключение: <script src="/js/toast.js"></script>
//  Использование:  toast('Сохранено', 'success')  — глобальный алиас
//                  CH.toast('Ошибка', 'error')    — то же самое
// ═══════════════════════════════════════════════════════════════

(function () {
  'use strict';

  var DURATION_MS = 3500;

  function ensureContainer() {
    var c = document.getElementById('toast-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'toast-container';
      document.body.appendChild(c);
    }
    return c;
  }

  /**
   * Показывает toast-уведомление.
   * @param {string} msg   — текст сообщения (вставляется как textContent)
   * @param {string} [type] — 'success' | 'error' | 'info'
   */
  function toast(msg, type) {
    var c = ensureContainer();
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = msg == null ? '' : String(msg);
    c.appendChild(el);
    setTimeout(function () { el.remove(); }, DURATION_MS);
  }

  toast.ensureContainer = ensureContainer;

  window.toast = toast;

  // CH.toast — если header.js ещё не загрузился, подставим при его готовности
  function bindCH() {
    if (window.CH && typeof window.CH.toast !== 'function') window.CH.toast = toast;
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindCH);
  } else {
    bindCH();
  }
})();
