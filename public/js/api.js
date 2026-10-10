// ══════════════════════════════════════════════════════════════
//  api.js — единый HTTP-клиент ChessHome (клиент)
// ══════════════════════════════════════════════════════════════
//  Централизованные обёртки над fetch (унификация, DRY — задача 2A):
//  раньше почти каждая страница держала собственную копию apiGet/apiPost
//  с чуть разным поведением. Теперь реализация одна.
//
//  Авторизация: токен и device id живут в HttpOnly-cookie (ch_token,
//  ch_device_id) — браузер прикладывает их к запросам на тот же origin сам,
//  никаких Authorization-заголовков из JS не требуется.
//
//  Транспортные политики (унаследованы от продакшен-реализаций):
//   • Ответ всегда читается как текст и парсится вручную: если прокси/
//     хостинг вернул HTML-страницу ошибки вместо JSON, бездумный res.json()
//     ронял страницу с «unexpected character» — здесь это превращается
//     в понятную ошибку.
//   • apiDelete шлёт POST на path + '/delete': DELETE как HTTP-метод режется
//     на уровне nginx/WAF у части посетителей; на сервере для всех таких
//     маршрутов (blog, news, forum, clubs, tournaments, dev-diary) есть
//     POST-дублёры именно на этот случай.
//   • apiPatch шлёт настоящий PATCH — WAF его не режет, POST-дублёры ('/edit')
//     существуют только у tournaments/clubs и остаются серверными.
//
//  Подключение: <script src="/js/api.js"></script> после /js/utils.js.

(function () {
  'use strict';

  const API_BASE = '/api';

  function parseApiResponse(res) {
    return res.text().then(function (text) {
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch (e) {
        // Ответ пришёл не в JSON (HTML-страница ошибки от прокси, обрыв
        // соединения, пустое тело) — не даём «сырой» ошибке JSON.parse
        // всплыть наружу.
        throw new Error('Сервер временно недоступен. Попробуйте ещё раз через минуту.');
      }
      if (!res.ok) throw new Error(data.error || 'Ошибка');
      return data;
    });
  }

  function apiReq(method, path, body) {
    const opts = { method: method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body === undefined ? {} : body);
    }
    return fetch(API_BASE + path, opts).then(parseApiResponse);
  }

  function apiGet(path)         { return apiReq('GET', path); }
  function apiPost(path, body)  { return apiReq('POST', path, body); }
  function apiPatch(path, body) { return apiReq('PATCH', path, body); }
  // DELETE → POST '/delete' (см. комментарий в шапке модуля).
  function apiDelete(path)      { return apiReq('POST', path + '/delete', {}); }

  if (typeof window !== 'undefined') {
    window.CH_API = { base: API_BASE, apiGet: apiGet, apiPost: apiPost, apiPatch: apiPatch, apiDelete: apiDelete, parseApiResponse: parseApiResponse };
    // Глобальные имена совпадают с историческими вызовами на страницах,
    // чтобы точки вызова не пришлось менять.
    window.parseApiResponse = parseApiResponse;
    window.apiGet = apiGet;
    window.apiPost = apiPost;
    window.apiPatch = apiPatch;
    window.apiDelete = apiDelete;
  }
  if (typeof module !== 'undefined') module.exports = { apiGet: apiGet, apiPost: apiPost, apiPatch: apiPatch, apiDelete: apiDelete, parseApiResponse: parseApiResponse };
})();
