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

// ═══════════════════════════════════════════════════════════════
//  ФИЛЬТР ЧАТА (мат / спам) — единая реализация (2В, унификация).
//  Раньше логика дублировалась: в app.js (лобби) и локально в clubs.html
//  (clubChatBadWords/chatNorm/chatHasBad). Теперь одна — здесь.
// ═══════════════════════════════════════════════════════════════

// Мат / реальные ругательства. Генерические оскорбления ("дебил","идиот",
// "тварь","урод","мразь","чмо","аутист","даун","жиробас") сюда не входят —
// это токсичность, а не мат, они были причиной того что фильтр казался
// слишком строгим. Настоящие ругательства остаются под запретом.
var MAT_WORDS = [
  'блять','блядь','бля','пиздец','пизда','пизду','пизды',
  'сука','сучка','хуй','хуе','хер',
  'ебать','ебал','ебан','ебаный','ебло','еблан','ебуч','заеб','выеб',
  'нахуй','нахер','похуй','похер',
  'гандон','долбоеб','долбоёб','далбаеб','далбоеб','далбоёб','мудак',
  'шлюха','шлюх','шалава','проститутка',
  'соси','сосать','отсоси','сраный','обосранный','пздц',
  'порн','влагалище','секс','сэкс','дрочка','пидор',
  // англ
  'fuck','fucking','bitch','asshole','dick','shit',
];

// Спам / казино / ставки / реклама — ищем максимально агрессивно (в одну
// сплошную строку без пробелов), чтобы ловить обход фильтра вставкой
// пробелов и точек: "к а з и н о", "т . м е" и т.п. Ложных срабатываний
// на обычные слова тут не бывает (это не мат-корни).
var SPAM_WORDS = [
  'казино','casino','ставки','ставка','bet','букмекер',
  '1xbet','melbet','parimatch','fonbet',
  'aviator','crash',
  'выигрыш','джекпот','бонус','бонусы','промокод','депозит',
  'фриспины','free spin',
  'прогноз','договорной матч',
  'http://','https://','www.',
  't.me','telegram','discord','discord.gg',
  'vk.com','instagram.com','tiktok.com',
  'легкие деньги', 'http','https','www','tme','discordgg'
];

// Замены букв/цифр для обхода фильтра (leetspeak) — без удаления
// пробелов, чтобы можно было отдельно проверять по словам.
function normalizeWord(text) {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[@]/g, 'a')
    .replace(/[0]/g, 'o')
    .replace(/[3]/g, 'e')
    .replace(/[1!]/g, 'i')
    .replace(/9/g, 'я')
    .replace(/6/g, 'б')
    .replace(/4/g, 'ч');
}

// Старая агрессивная нормализация (для спам/казино-проверки): убираем
// вообще все пробелы и небуквенные символы, чтобы ловить обход через
// расстановку пробелов между буквами.
function normalize(text) {
  return normalizeWord(text)
    .replace(/\s+/g, '')
    .replace(/[^a-zа-я0-9]/gi, '');
}

function containsBadWords(text) {
  const collapsed = normalize(text);
  if (SPAM_WORDS.some(word => collapsed.includes(normalize(word)))) return true;

  // Мат — проверяем по отдельным словам, а не по случайной подстроке
  // посреди текста. Короткие корни (3 буквы и меньше, типа "бля",
  // "хер") ловим ТОЛЬКО как начало слова — иначе словим "рубля",
  // "сабля", "кораблях" и подобные ни при чём не виноватые слова,
  // которые просто ЗАКАНЧИВАются на такое сочетание букв. Более
  // длинные и однозначные корни ("блять","пиздец","ебаный"...)
  // по-прежнему ищем где угодно внутри слова — это по-прежнему
  // ловит приставочные формы вроде "разъебали".
  const tokens = normalizeWord(text).replace(/[^a-zа-я0-9\s]/gi, '').split(/\s+/).filter(Boolean);
  return MAT_WORDS.some(rawWord => {
    const word = normalizeWord(rawWord).replace(/[^a-zа-я0-9]/gi, '');
    if (!word) return false;
    // "хер" отдельно — только точное совпадение слова целиком, иначе
    // ловит "Херсон", "херувим" и подобные ни при чём не виноватые слова.
    if (word === 'хер') return tokens.includes(word);
    if (word.length <= 3) return tokens.some(t => t.startsWith(word));
    return tokens.some(t => t.includes(word));
  });
}

// ═══════════════════════════════════════════════════════════════
//  ДАТА И ВРЕМЯ — единые реализации (2Г, унификация).
//  Раньше копии жили в blog.html, news.html, inbox.html,
//  interclub-tournament(s).html. Теперь одна — здесь.
// ═══════════════════════════════════════════════════════════════

/**
 * Дата «12 марта 2026» с учётом языка интерфейса (en → en-US, иначе ru-RU).
 * Канонична defensive-версия из news.html — не падает, если i18n ещё не загружен.
 */
function formatDate(ts) {
  const i18n = (typeof window !== 'undefined') ? window.CH_I18N : null;
  const locale = (i18n && i18n.getLang && i18n.getLang() === 'en') ? 'en-US' : 'ru-RU';
  return new Date(ts).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
}

// Турниры всегда показываются в московском времени (UTC+3), независимо
// от таймзоны сервера/браузера.
function formatMskDateTime(ts) {
  return new Date(ts).toLocaleString('ru-RU', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Moscow'
  }) + ' МСК';
}

function formatMskShort(ts) {
  return new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
}

// «15:47» / «вчера» / «сб» / «21.03» — для списков сообщений.
function relativeTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  }
  const days = Math.floor((now - d) / 86400000);
  if (days === 1) return 'вчера';
  if (days < 7) return d.toLocaleDateString('ru', { weekday: 'short' });
  return d.toLocaleDateString('ru', { day: '2-digit', month: '2-digit' });
}

// «15:47» — время из таймстампа.
// ВНИМАНИЕ: это ФОРМАТТИРОВАНИЕ ДАТЫ. Форматирование шахматных часов
// (секунды → «m:ss») — отдельная функция formatClock внутри /js/board.js.
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}

// «Сегодня» / «Вчера» / «12 марта» — заголовки дней в переписке.
function formatDay(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Сегодня';
  const days = Math.floor((now - d) / 86400000);
  if (days === 1) return 'Вчера';
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'long' });
}

if (typeof window !== 'undefined') {
  window.MAT_WORDS = MAT_WORDS;
  window.SPAM_WORDS = SPAM_WORDS;
  window.normalizeWord = normalizeWord;
  window.normalize = normalize;
  window.containsBadWords = containsBadWords;
  window.formatDate = formatDate;
  window.formatMskDateTime = formatMskDateTime;
  window.formatMskShort = formatMskShort;
  window.relativeTime = relativeTime;
  window.formatTime = formatTime;
  window.formatDay = formatDay;
}
