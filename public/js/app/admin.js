// ═══════════════════════════════════════════════════════════
//  app/admin.js — админ-панель: поиск и модерация пользователей
// ═══════════════════════════════════════════════════════════
//  Вынесено из монолитного app.js в рамках рефакторинга.
//  Код не изменён. Файл — классический скрипт в глобальной области,
//  подключается после /js/app/core.js в исходном порядке следования.

async function adminLoadUsers() {
  const listEl = document.getElementById('admin-users-list');
  const countEl = document.getElementById('admin-users-count');
  if (!listEl) return;
  try {
    const users = await apiGet('/admin/users');
    if (countEl) countEl.textContent = '(' + users.length + ')';
    renderAdminUserList(users, listEl);
  } catch {
    // НЕ используем leaderboard как fallback — это утечка данных
    listEl.innerHTML = '<div class="empty-state"><p>Нет доступа или ошибка загрузки</p></div>';
  }
}

function renderAdminUserList(users, container) {
  if (!users.length) {
    container.innerHTML = '<div class="empty-state"><p>Нет пользователей</p></div>';
    return;
  }
  // Строим через DOM — никаких вложенных template literals
  container.innerHTML = '';
  users.forEach(u => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)';

    // Аватар
    const avatar = document.createElement('div');
    avatar.className = 'player-avatar';
    avatar.style.cssText = 'width:36px;height:36px;font-size:15px;cursor:pointer;flex-shrink:0';
    avatar.textContent = u.username[0].toUpperCase();
    avatar.addEventListener('click', () => openUserProfile(u.username));
    row.appendChild(avatar);

    // Инфо
    const info = document.createElement('div');
    info.style.flex = '1';
    const nameEl = document.createElement('div');
    nameEl.style.cssText = 'font-weight:600;font-size:14px';
    nameEl.textContent = u.username;
    if (u.role === 'admin') {
      const badge = document.createElement('span');
      badge.style.cssText = 'color:var(--accent);font-size:11px;margin-left:6px';
      badge.textContent = 'ADMIN';
      nameEl.appendChild(badge);
    }
    if (u.vip) {
      const vipImg = document.createElement('img');
      vipImg.src = '/img/vip.png';
      vipImg.alt = 'VIP';
      vipImg.title = u.vipUntil ? ('VIP до ' + new Date(u.vipUntil).toLocaleDateString('ru')) : 'VIP';
      vipImg.style.cssText = 'height:15px;width:auto;vertical-align:middle;margin-left:6px';
      nameEl.appendChild(vipImg);
    }
    if (u.banned) {
      const ban = document.createElement('span');
      ban.style.cssText = 'color:var(--red);font-size:11px;margin-left:6px';
      ban.textContent = 'БАН';
      nameEl.appendChild(ban);
    }
    const statsEl = document.createElement('div');
    statsEl.style.cssText = 'font-size:12px;color:var(--text-muted)';
    statsEl.textContent = '★' + u.rating + ' · ' + u.gamesPlayed + ' партий · ' + u.wins + 'W/' + u.losses + 'L';
    info.appendChild(nameEl);
    info.appendChild(statsEl);
    row.appendChild(info);

    // Кнопки
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:6px';
    const canGrantVip = currentUser && ['chesshome', 'marina64'].includes(currentUser.username.toLowerCase());
    if (canGrantVip) {
      if (u.vip) {
        const revokeBtn = document.createElement('button');
        revokeBtn.className = 'btn btn-ghost btn-sm';
        revokeBtn.textContent = '✨ Снять VIP';
        revokeBtn.addEventListener('click', async () => {
          if (!confirm('Снять VIP-значок у ' + u.username + '?')) return;
          try { await apiPost('/admin/vip/revoke', { username: u.username }); toast('VIP снят', 'success'); adminLoadUsers(); }
          catch (e) { toast(e.message, 'error'); }
        });
        btns.appendChild(revokeBtn);
      } else {
        const grantBtn = document.createElement('button');
        grantBtn.className = 'btn btn-ghost btn-sm';
        grantBtn.textContent = '✨ Выдать VIP';
        grantBtn.addEventListener('click', async () => {
          const days = prompt('На сколько дней выдать VIP-значок ' + u.username + '?', '30');
          if (days === null) return;
          try { await apiPost('/admin/vip/grant', { username: u.username, days: parseInt(days) || 30 }); toast('VIP выдан', 'success'); adminLoadUsers(); }
          catch (e) { toast(e.message, 'error'); }
        });
        btns.appendChild(grantBtn);
      }
    }
    if (u.username === currentUser.username) {
      const self = document.createElement('span');
      self.style.cssText = 'color:var(--text-muted);font-size:12px';
      self.textContent = 'это вы';
      btns.appendChild(self);
    } else if (u.banned) {
      const unbanBtn = document.createElement('button');
      unbanBtn.className = 'btn btn-secondary btn-sm';
      unbanBtn.textContent = '✅ Разбан';
      unbanBtn.addEventListener('click', async () => { await adminUnban(u.username); adminLoadUsers(); });
      btns.appendChild(unbanBtn);
    } else {
      const banBtn = document.createElement('button');
      banBtn.className = 'btn btn-danger btn-sm';
      banBtn.textContent = '🚫 Бан';
      banBtn.addEventListener('click', () => adminBanInline(u.username));
      btns.appendChild(banBtn);
    }
    row.appendChild(btns);
    container.appendChild(row);
  });
}

// Дубликат проверки роли из app.js/app/profile.js: adminBanInline доступен
// в window и может быть вызван из консоли не-админом — не показываем prompt
// и не отправляем запрос, который сервер всё равно вернёт с 403.
function isAdminClient() {
  return !!(currentUser && currentUser.role === 'admin');
}

async function adminBanInline(username) {
  if (!isAdminClient()) { toast('Нет прав', 'error'); return; }
  const reason = prompt('Причина бана ' + username + ':', 'Нарушение правил');
  if (reason === null) return;
  try {
    await apiPost('/admin/ban', { username, reason });
    toast(username + ' заблокирован', 'success');
    await adminLoadUsers();
  } catch (e) { toast(e.message, 'error'); }
}

let adminSearchTimer = null;
async function adminSearchUsers(q) {
  clearTimeout(adminSearchTimer);
  const resultsEl = document.getElementById('admin-search-results');
  if (!resultsEl) return;
  if (!q || q.length < 1) { resultsEl.innerHTML = ''; return; }
  adminSearchTimer = setTimeout(async () => {
    try {
      const users = await apiGet('/users/search?q=' + encodeURIComponent(q));
      renderAdminUserList(users, resultsEl);
    } catch {}
  }, 250);
}


// ─── РЕДЖОЙН БАННЕР ───────────────────────────────────────────
