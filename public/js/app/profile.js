// ═══════════════════════════════════════════════════════════
//  app/profile.js — профили пользователей, поиск, быстрые действия
// ═══════════════════════════════════════════════════════════
//  Вынесено из монолитного app.js в рамках рефакторинга.
//  Код не изменён. Файл — классический скрипт в глобальной области,
//  подключается после /js/app/core.js в исходном порядке следования.

let searchTimeout = null;

async function searchUsers(q) {
  const resultsEl = document.getElementById('search-results');
  if (!resultsEl) return;
  if (!q || q.length < 1) { resultsEl.style.display = 'none'; return; }
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    try {
      const results = await apiGet('/users/search?q=' + encodeURIComponent(q));
      if (!results.length) { resultsEl.style.display = 'none'; return; }
      resultsEl.style.display = 'block';
      resultsEl.innerHTML = results.map(u => `
        <div class="search-result-item" onclick="openUserProfile('${u.username}')">
          <div class="result-avatar">${u.username[0].toUpperCase()}</div>
          <div>
            <div class="result-name">${escapeHtml(u.username)} ${u.online ? '<span class="result-online">● онлайн</span>' : ''}</div>
            <div class="result-rating">Рейтинг: ${u.rating}</div>
          </div>
        </div>`).join('');
    } catch {}
  }, 250);
}

// Открыть страницу профиля любого игрока
function openUserProfile(username) {
  // Закрываем поиск
  const resultsEl = document.getElementById('search-results');
  if (resultsEl) resultsEl.style.display = 'none';
  const searchEl = document.getElementById('player-search');
  if (searchEl) searchEl.value = '';

  // Закрываем любые открытые модалы
  document.getElementById('modal-user-profile')?.classList.remove('open');

  // Открываем профиль как страницу (SPA-навигация)
  window._profileTarget = username;
  window.location.href = '/profile/' + encodeURIComponent(username);
}

function showUserProfileModal(user) {
  const isMe     = user.username === currentUser?.username;
  const isOnline = user.online;
  const isAdmin  = currentUser?.role === 'admin';
  const winPct   = user.gamesPlayed > 0 ? Math.round(user.wins / user.gamesPlayed * 100) : 0;

  let modal = document.getElementById('modal-user-profile');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-user-profile';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
  }

  // Строим через DOM — никаких вложенных шаблонных строк
  modal.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'modal';
  box.style.cssText = 'position:relative;max-width:420px;text-align:center';

  // Закрытие
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close';
  closeBtn.textContent = '✕';
  closeBtn.onclick = () => modal.classList.remove('open');
  box.appendChild(closeBtn);

  // Аватар
  const av = document.createElement('div');
  av.className = 'player-avatar';
  av.style.cssText = 'width:64px;height:64px;font-size:28px;margin:0 auto 12px';
  av.textContent = user.username[0].toUpperCase();
  box.appendChild(av);

  // Имя
  const h2 = document.createElement('h2');
  h2.style.cssText = 'font-family:var(--font-display);font-size:22px;margin-bottom:4px';
  h2.textContent = user.username;
  if (user.vip) {
    const vipImg = document.createElement('img');
    vipImg.src = '/img/vip.png';
    vipImg.alt = 'VIP';
    vipImg.title = 'VIP-игрок';
    vipImg.style.cssText = 'height:20px;width:auto;vertical-align:middle;margin-left:6px';
    h2.appendChild(vipImg);
  }
  if (user.role === 'admin') {
    const badge = document.createElement('span');
    badge.style.cssText = 'color:var(--accent);font-size:13px;margin-left:8px';
    badge.textContent = 'ADMIN';
    h2.appendChild(badge);
  }
  box.appendChild(h2);

  // Онлайн + дата
  const meta = document.createElement('div');
  meta.style.cssText = 'color:var(--text-muted);font-size:12px;margin-bottom:12px';
  const onlineSpan = document.createElement('span');
  onlineSpan.style.color = isOnline ? 'var(--green)' : 'var(--text-muted)';
  onlineSpan.textContent = isOnline ? '● онлайн' : '● оффлайн';
  meta.appendChild(onlineSpan);
  meta.appendChild(document.createTextNode(' · На сайте с ' + new Date(user.createdAt).toLocaleDateString('ru')));
  box.appendChild(meta);

  // Рейтинг
  const rating = document.createElement('div');
  rating.style.cssText = 'font-size:28px;color:var(--accent);font-family:var(--font-mono);margin-bottom:16px';
  rating.textContent = '★ ' + user.rating;
  box.appendChild(rating);

  // Статы
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px';
  [
    [user.gamesPlayed, 'Партий', ''],
    [user.wins,        'Побед',  'var(--green)'],
    [user.losses,      'Пор.',   'var(--red)'],
    [winPct + '%',     'Винрейт',''],
  ].forEach(([val, label, color]) => {
    const cell = document.createElement('div');
    const num = document.createElement('div');
    num.style.cssText = 'font-size:20px;font-weight:700' + (color ? ';color:' + color : '');
    num.textContent = val;
    const lbl = document.createElement('div');
    lbl.style.cssText = 'color:var(--text-muted);font-size:11px';
    lbl.textContent = label;
    cell.appendChild(num); cell.appendChild(lbl);
    grid.appendChild(cell);
  });
  box.appendChild(grid);

  // Кнопки действий
  if (!isMe) {
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:center;flex-wrap:wrap';

    // Вызвать на игру
    if (isOnline && currentUser) {
      const challengeBtn = document.createElement('button');
      challengeBtn.className = 'btn btn-primary btn-sm';
      challengeBtn.textContent = '⚔️ Вызвать';
      challengeBtn.addEventListener('click', () => challengeUserFromProfile(user.username));
      actions.appendChild(challengeBtn);
    }

    // Написать личное сообщение
    if (currentUser) {
      const dmBtn = document.createElement('button');
      dmBtn.className = 'btn btn-secondary btn-sm';
      dmBtn.textContent = '✉️ Написать';
      dmBtn.addEventListener('click', () => {
        modal.classList.remove('open');
        window.location = '/inbox/' + encodeURIComponent(user.username);
      });
      actions.appendChild(dmBtn);
    }

    // Пожаловаться (не для admin)
    if (currentUser && !isAdmin) {
      const reportBtn = document.createElement('button');
      reportBtn.className = 'btn btn-ghost btn-sm';
      reportBtn.textContent = '🚩 Репорт';
      reportBtn.addEventListener('click', () => {
        modal.classList.remove('open');
        showReportModal(user.username);
      });
      actions.appendChild(reportBtn);
    }

    // Бан/разбан (только admin)
    if (isAdmin) {
      if (user.banned) {
        const unbanBtn = document.createElement('button');
        unbanBtn.className = 'btn btn-secondary btn-sm';
        unbanBtn.textContent = '✅ Разбан';
        unbanBtn.addEventListener('click', async () => {
          await adminUnban(user.username);
          modal.classList.remove('open');
        });
        actions.appendChild(unbanBtn);
      } else {
        const banBtn = document.createElement('button');
        banBtn.className = 'btn btn-danger btn-sm';
        banBtn.textContent = '🚫 Бан';
        banBtn.addEventListener('click', async () => {
          await adminBan(user.username);
          modal.classList.remove('open');
        });
        actions.appendChild(banBtn);
      }
    }

    box.appendChild(actions);
  } else {
    const self = document.createElement('div');
    self.style.cssText = 'color:var(--text-muted);font-size:13px';
    self.textContent = 'Это вы';
    box.appendChild(self);
  }

  modal.appendChild(box);
  modal.classList.add('open');
}


function challengeUserFromProfile(username) {
  document.getElementById('modal-user-profile')?.classList.remove('open');
  if (!currentUser) { openModal('modal-login'); return; }
  if (!socket) { toast('Нет соединения. Войдите заново.', 'error'); return; }
  const rated = !confirm('Сделать партию товарищеской (без изменения рейтинга)?\n\nОК — товарищеская, Отмена — рейтинговая.');
  // Тост «Вызов отправлен!» убран: успех показывался ДО ответа сервера,
  // и при офлайне цели пользователь видел «успех», а следом ошибку
  // «Не в сети». Старт партии (game_start) — сам по себе подтверждение;
  // об ошибке сообщит стандартный обработчик socket 'error'.
  socket.emit('challenge_user', { username, rated, timeControl: selectedTC });
}

// Функции доступны в window (классический скрипт), поэтому их может
// вызвать кто угодно из консоли DevTools. Сервер всё равно отклонит
// запрос не-админа (403), но проверку роли дублируем на клиенте:
// непривилегированному пользователю не показываем админский prompt
// и не гоняем заведомо запрещённые запросы к /api/admin/*.
function isAdminClient() {
  return !!(currentUser && currentUser.role === 'admin');
}

async function adminBan(username) {
  if (!isAdminClient()) { toast('Нет прав', 'error'); return; }
  const reason = prompt(`Причина бана ${username}:`, 'Нарушение правил');
  if (reason === null) return;
  try {
    await apiPost('/admin/ban', { username, reason });
    toast(`${username} заблокирован`, 'success');
    document.getElementById('modal-user-profile')?.classList.remove('open');
  } catch (e) { toast(e.message, 'error'); }
}

async function adminUnban(username) {
  if (!isAdminClient()) { toast('Нет прав', 'error'); return; }
  try {
    await apiPost('/admin/unban', { username });
    toast(`${username} разблокирован`, 'success');
    document.getElementById('modal-user-profile')?.classList.remove('open');
  } catch (e) { toast(e.message, 'error'); }
}

// Старая функция challengeUser (для совместимости с лобби)
function challengeUser(username) {
  challengeUserFromProfile(username);
}


// ─── GAME UI ──────────────────────────────────────────────────
