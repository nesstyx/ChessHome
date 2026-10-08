/**
 * online-widget.js
 * Shared online presence widget for all Chess Home pages.
 *
 * What it does:
 *  1. Connects to socket.io (auth via HttpOnly cookie in the handshake) → registers current user as online
 *  2. Listens for `online_count` events and updates #online-count
 *  3. Makes the .online-badge clickable → navigates to /online
 *
 * Include AFTER socket.io.js:
 *   <script src="/socket.io/socket.io.js"></script>
 *   <script src="/js/online-widget.js"></script>
 *
 * The badge element must exist in the page, e.g.:
 *   <div class="online-badge" id="online-badge-btn" ...>
 *     <div class="online-dot"></div>
 *     <span id="online-count">0</span> онлайн
 *   </div>
 */
(function () {
  'use strict';

  var API = '/api';
  var socket = null;

  // ── helpers ────────────────────────────────────────────────────

  // Мёртвый код попапа УДАЛЕН (createPopup, positionPopup,
  // renderPopupLoading, loadUserList, openPopup, closePopup и локальная
  // escHtml): клик по бейджу всегда ведёт на /online, попап технически
  // невозможно было открыть.

  function setCount(n) {
    // header.js использует id="ch-online-count" и "ch-drawer-online-count"
    // Поддерживаем оба варианта для совместимости
    ['online-count', 'ch-online-count', 'ch-drawer-online-count'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.textContent = n;
    });
    // Также обновляем через CH API если доступен
    if (window.CH && typeof CH.setOnlineCount === 'function') CH.setOnlineCount(n);
  }

  // ── socket connection ──────────────────────────────────────────

  


  // clicking any online-count element → go to /online page
  function bindCountClicks() {
    ['online-count', 'ch-online-count', 'ch-drawer-online-count'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el && !el._onlinePageBound) {
        el._onlinePageBound = true;
        el.style.cursor = 'pointer';
        el.addEventListener('click', function(e) {
          e.stopPropagation();
          window.location.href = '/online';
        });
      }
    });
  }


  function connectSocket() {
    // io() is provided by socket.io.js; bail if not loaded yet
    if (typeof io !== 'function') return;
    if (socket) return;

    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('online_count', function (count) {
      setCount(count);
    });

    // НЕ обнуляем socket — socket.io сам переподключится, сервер авторизует
    // сокет по HttpOnly-cookie из handshake, отдельный emit('auth') не нужен
  }

  // ── badge click handler ────────────────────────────────────────

  function initBadge() {
    // header.js создаёт бейдж с id="ch-online-badge"
    var badge = document.getElementById('ch-online-badge') ||
                document.getElementById('online-badge-btn') ||
                document.querySelector('.online-badge');
    if (!badge) return;
    if (badge._onlinePageBound) return;
    badge._onlinePageBound = true;

    // Убираем старый onclick
    badge.onclick = null;
    badge.style.cursor = 'pointer';
    badge.title = 'Посмотреть кто онлайн';

    badge.addEventListener('click', function (e) {
      e.stopPropagation();
      window.location.href = '/online';
    });

    // Also bind count elements that may now exist
    bindCountClicks();
  }

  // ── init ───────────────────────────────────────────────────────

  function init() {
    // Connect socket to mark ourselves online
    if (typeof io === 'function') {
      connectSocket();
    } else {
      // socket.io.js not yet loaded — wait
      var attempts = 0;
      var iv = setInterval(function () {
        if (typeof io === 'function') {
          clearInterval(iv);
          connectSocket();
        }
        if (++attempts > 40) clearInterval(iv);
      }, 150);
    }

    // Bind click → /online on any already-existing elements
    bindCountClicks();

    // Бейдж инжектируется header.js позже — ждём появления в DOM
    initBadge();
    if (!document.getElementById('online-badge-btn') && !document.querySelector('.online-badge')) {
      var badgeObserver = new MutationObserver(function () {
        var badge = document.getElementById('ch-online-badge') || document.getElementById('online-badge-btn') || document.querySelector('.online-badge');
        if (badge) {
          badgeObserver.disconnect();
          initBadge();
        }
        // Also re-bind counts whenever DOM changes (header may inject count els)
        bindCountClicks();
      });
      badgeObserver.observe(document.body, { childList: true, subtree: true });
    }

    // Fallback: if socket never fires online_count, poll once via REST
    setTimeout(async function () {
      var anyEl = ['online-count','ch-online-count','ch-drawer-online-count']
        .map(function(id){ return document.getElementById(id); })
        .find(Boolean);
      if (anyEl && anyEl.textContent === '0') {
        try {
          // куки отправляются автоматически (same-origin), Bearer-заголовок не нужен
          var res = await fetch(API + '/online/users');
          var d = await res.json();
          if (Array.isArray(d)) setCount(d.length);
          else if (d.count != null) setCount(d.count);
        } catch {}
      }
    }, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();