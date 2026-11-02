/**
 * Бэкенд сайта заказов докладов и презентаций.
 * Google Apps Script, привязанный к Google Таблице.
 *
 * Свойства скрипта (Настройки проекта → Свойства скрипта):
 *   ADMIN_PASSWORD — пароль от админки (обязательно)
 *   TG_TOKEN       — токен Telegram-бота (необязательно)
 *   TG_CHAT_ID     — ваш chat_id в Telegram (необязательно)
 * Настройки цен хранятся в свойстве CONFIG (JSON) — его меняет админка.
 */

var SHEET_NAME = 'Заказы';

var COLUMNS = [
  ['id', '№'],
  ['created', 'Создано'],
  ['name', 'Имя'],
  ['contact', 'Контакт'],
  ['service', 'Услуга'],
  ['volume', 'Объём'],
  ['unit', 'Ед.'],
  ['topic', 'Тема'],
  ['subject', 'Предмет'],
  ['grade', 'Класс/курс'],
  ['deadline', 'Нужно к'],
  ['options', 'Опции'],
  ['wishes', 'Пожелания'],
  ['calcPrice', 'Цена (расчёт сайта)'],
  ['status', 'Статус'],
  ['price', 'Цена'],
  ['paid', 'Оплачено'],
  ['expenses', 'Расходы'],
  ['notes', 'Заметки']
];

var STATUSES = { 'new': 'Новый', 'work': 'В работе', 'revision': 'На правках', 'done': 'Сдан', 'cancelled': 'Отменён' };

var RATE_LIMIT = 5;          // заявок с одного контакта
var RATE_WINDOW_SEC = 3600;  // за час

var DEFAULT_CONFIG = {
  heroTitle: 'Доклады и презентации на заказ',
  heroSubtitle: 'Сделаю доклад, презентацию или текст выступления точно к сроку. Цену видно сразу — без сюрпризов.',
  contact: '@your_telegram',
  note: 'Цена предварительная — точную сумму подтвержу, когда обсудим детали. Работу начинаю после предоплаты.',
  services: [
    { id: 'report', name: 'Доклад', unit: 'стр.', price: 150, min: 800,
      desc: 'Структурированный текст: введение, основная часть, выводы и список источников.' },
    { id: 'slides', name: 'Презентация', unit: 'слайд', price: 100, min: 700,
      desc: 'Современный аккуратный дизайн, схемы и иллюстрации, минимум текста на слайдах.' },
    { id: 'combo', name: 'Доклад + презентация', unit: 'стр.', price: 230, min: 1300,
      desc: 'Доклад и презентация к нему в едином стиле. Объём считается по страницам доклада.' },
    { id: 'speech', name: 'Текст выступления', unit: 'мин', price: 80, min: 400,
      desc: 'Текст, который удобно читать вслух, под нужную длительность выступления.' }
  ],
  options: [
    { id: 'plagiarism', name: 'Антиплагиат + отчёт', price: 200 },
    { id: 'notes', name: 'Заметки докладчика', price: 300 }
  ],
  urgency: { days: 3, percent: 30 },
  prepay: 50
};

/* ===================== Точки входа ===================== */

/** Проверка, что веб-приложение опубликовано: откройте ссылку /exec в браузере. */
function doGet() {
  return json_({ ok: true, message: 'API работает. Сайт обращается сюда через POST.' });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'Неверный формат запроса' });
  }
  try {
    switch (String(req.action || '')) {
      // Публичные
      case 'config':
        return json_({ ok: true, config: getConfig_() });
      case 'order':
        return json_(createOrder_(req.order || {}));
      case 'login':
        requireAdmin_(req);
        return json_({ ok: true });
      // По паролю
      case 'list':
        requireAdmin_(req);
        return json_({ ok: true, orders: listOrders_() });
      case 'update':
        requireAdmin_(req);
        return json_(updateOrder_(req.id, req.fields || {}));
      case 'delete':
        requireAdmin_(req);
        return json_(deleteOrder_(req.id));
      case 'saveConfig':
        requireAdmin_(req);
        return json_(saveConfig_(req.config));
      default:
        return json_({ ok: false, error: 'Неизвестное действие' });
    }
  } catch (err) {
    if (err && err.code) return json_({ ok: false, code: err.code, error: err.message });
    console.error(err);
    return json_({ ok: false, error: 'Ошибка сервера: ' + (err && err.message ? err.message : err) });
  }
}

/* ===================== Пароль ===================== */

function requireAdmin_(req) {
  var real = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  if (!real) throw codeError_('Пароль не задан: добавьте свойство ADMIN_PASSWORD в настройках скрипта.', 'auth');
  var pw = String(req.password || '');
  if (!safeEqual_(pw, real)) {
    // Задержка от подбора: растёт с числом неудачных попыток за последние 15 минут
    var cache = CacheService.getScriptCache();
    var fails = Number(cache.get('login_fails') || 0) + 1;
    cache.put('login_fails', String(fails), 900);
    Utilities.sleep(Math.min(1500 + fails * 500, 8000));
    throw codeError_('Неверный пароль', 'auth');
  }
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ===================== Настройки ===================== */

function getConfig_() {
  var raw = PropertiesService.getScriptProperties().getProperty('CONFIG');
  if (!raw) return normalizeConfig_(DEFAULT_CONFIG);
  try {
    return normalizeConfig_(JSON.parse(raw));
  } catch (e) {
    return normalizeConfig_(DEFAULT_CONFIG);
  }
}

function saveConfig_(input) {
  if (!input || typeof input !== 'object') throw codeError_('Нет настроек для сохранения', 'validation');
  var cfg = normalizeConfig_(input);
  var text = JSON.stringify(cfg);
  if (text.length > 8500) throw codeError_('Слишком много текста в настройках — сократите описания', 'validation');
  PropertiesService.getScriptProperties().setProperty('CONFIG', text);
  return { ok: true, config: cfg };
}

function normalizeConfig_(raw) {
  raw = raw && typeof raw === 'object' ? raw : {};
  var d = DEFAULT_CONFIG;
  var used = {};
  function cleanId(id, prefix) {
    id = String(id || '').replace(/[^\w-]/g, '').slice(0, 40);
    if (!id || used[id]) id = prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
    used[id] = true;
    return id;
  }
  var services = (Array.isArray(raw.services) ? raw.services : d.services).slice(0, 30).map(function (s) {
    s = s || {};
    return {
      id: cleanId(s.id, 's'),
      name: str_(s.name, 80),
      unit: str_(s.unit, 15) || 'стр.',
      price: Math.round(clamp_(s.price, 0, 1e6, 0)),
      min: Math.round(clamp_(s.min, 0, 1e7, 0)),
      desc: str_(s.desc, 400)
    };
  }).filter(function (s) { return s.name; });
  if (!services.length) services = JSON.parse(JSON.stringify(d.services));

  var options = (Array.isArray(raw.options) ? raw.options : d.options).slice(0, 20).map(function (o) {
    o = o || {};
    return { id: cleanId(o.id, 'o'), name: str_(o.name, 80), price: Math.round(clamp_(o.price, 0, 1e6, 0)) };
  }).filter(function (o) { return o.name; });

  var u = raw.urgency || d.urgency;
  function text(key, max) { return raw[key] == null ? d[key] : str_(raw[key], max); }
  return {
    heroTitle: text('heroTitle', 120),
    heroSubtitle: text('heroSubtitle', 400),
    contact: text('contact', 100),
    note: text('note', 600),
    services: services,
    options: options,
    urgency: {
      days: Math.round(clamp_(u.days, 0, 60, d.urgency.days)),
      percent: Math.round(clamp_(u.percent, 0, 500, d.urgency.percent))
    },
    prepay: Math.round(clamp_(raw.prepay, 0, 100, d.prepay))
  };
}

/* ===================== Расчёт цены (та же формула, что в common.js) ===================== */

function calcPrice_(cfg, input, today) {
  var service = null;
  cfg.services.forEach(function (s) { if (s.id === input.serviceId) service = s; });
  var volume = Math.floor(Number(input.volume) || 0);
  if (!service || volume < 1) return { ok: false };

  var raw = service.price * volume;
  var base = Math.max(raw, service.min);
  var chosen = cfg.options.filter(function (o) { return input.options.indexOf(o.id) !== -1; });
  var optionsSum = chosen.reduce(function (s, o) { return s + o.price; }, 0);

  var daysLeft = daysBetween_(today, input.deadline);
  var urgent = daysLeft >= 0 && cfg.urgency.percent > 0 && daysLeft < cfg.urgency.days;
  var urgencySum = urgent ? Math.round(base * cfg.urgency.percent / 100) : 0;

  var total = round10_(base + optionsSum + urgencySum);
  var prepay = round10_(total * cfg.prepay / 100);
  return {
    ok: true, service: service, volume: volume, base: base, options: chosen,
    optionsSum: optionsSum, urgent: urgent, urgencySum: urgencySum, daysLeft: daysLeft,
    total: total, prepay: prepay
  };
}

function round10_(n) { return Math.round(n / 10) * 10; }

/* ===================== Заявки ===================== */

function createOrder_(o) {
  // Ловушка для ботов: делаем вид, что всё хорошо, но ничего не сохраняем
  if (str_(o.website, 200)) return { ok: true, id: 0, total: 0, prepay: 0 };

  var cfg = getConfig_();
  var today = todayStr_();
  var clean = {
    name: str_(o.name, 100),
    contact: str_(o.contact, 100),
    serviceId: str_(o.serviceId, 40),
    topic: str_(o.topic, 300),
    volume: Math.floor(Number(String(o.volume || '').replace(',', '.')) || 0),
    deadline: str_(o.deadline, 10),
    subject: str_(o.subject, 100),
    grade: str_(o.grade, 50),
    wishes: str_(o.wishes, 2000),
    options: (Array.isArray(o.options) ? o.options : []).slice(0, 50).map(function (x) { return str_(x, 40); })
  };

  if (!clean.name) return fail_('Укажите имя');
  if (clean.contact.length < 3) return fail_('Укажите Telegram или телефон');
  if (!cfg.services.some(function (s) { return s.id === clean.serviceId; })) return fail_('Выберите услугу');
  if (!clean.topic) return fail_('Укажите тему');
  if (!(clean.volume >= 1 && clean.volume <= 1000)) return fail_('Объём должен быть от 1 до 1000');
  if (!isDateStr_(clean.deadline)) return fail_('Укажите дату, к которой нужна работа');
  var dl = daysBetween_(today, clean.deadline);
  if (dl < 0) return fail_('Дата не может быть раньше сегодняшней');
  if (dl > 730) return fail_('Слишком далёкая дата');
  clean.options = cfg.options.filter(function (x) { return clean.options.indexOf(x.id) !== -1; })
    .map(function (x) { return x.id; });

  // Не больше 5 заявок с одного контакта в час
  var cache = CacheService.getScriptCache();
  var rlKey = 'rl_' + md5_(clean.contact.toLowerCase().replace(/[\s()\-]/g, ''));
  var rl = parseRate_(cache.get(rlKey));
  var now = Date.now();
  if (rl.count >= RATE_LIMIT && now - rl.start < RATE_WINDOW_SEC * 1000) {
    return fail_('Слишком много заявок с этого контакта. Попробуйте через час или напишите мне напрямую.');
  }

  var calc = calcPrice_(cfg, clean, today);
  if (!calc.ok) return fail_('Не удалось рассчитать цену');

  var id;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getSheet_();
    id = nextId_(sheet);
    var row = {
      id: String(id),
      created: Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm'),
      name: clean.name,
      contact: clean.contact,
      service: calc.service.name,
      volume: String(clean.volume),
      unit: calc.service.unit,
      topic: clean.topic,
      subject: clean.subject,
      grade: clean.grade,
      deadline: clean.deadline,
      options: calc.options.map(function (x) { return x.name; }).join(', '),
      wishes: clean.wishes,
      calcPrice: String(calc.total),
      status: STATUSES['new'],
      price: String(calc.total),
      paid: '',
      expenses: '',
      notes: ''
    };
    var values = COLUMNS.map(function (c) { return escapeCell_(row[c[0]]); });
    var r = sheet.getLastRow() + 1;
    var range = sheet.getRange(r, 1, 1, COLUMNS.length);
    range.setNumberFormat('@');
    range.setValues([values]);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  // Счётчик для ограничения частоты
  if (now - rl.start >= RATE_WINDOW_SEC * 1000) rl = { count: 0, start: now };
  rl.count++;
  var ttl = Math.max(60, Math.ceil((rl.start + RATE_WINDOW_SEC * 1000 - now) / 1000));
  cache.put(rlKey, JSON.stringify(rl), ttl);

  try {
    notifyTelegram_(id, clean, calc);
  } catch (e) {
    console.error('Telegram:', e);
  }

  return { ok: true, id: id, total: calc.total, prepay: calc.prepay };
}

function parseRate_(v) {
  try {
    var r = JSON.parse(v || '');
    if (r && typeof r.count === 'number' && typeof r.start === 'number') return r;
  } catch (e) { /* пусто */ }
  return { count: 0, start: Date.now() };
}

function nextId_(sheet) {
  var props = PropertiesService.getScriptProperties();
  var last = Number(props.getProperty('LAST_ID') || 0);
  var rows = sheet.getLastRow() - 1;
  if (rows > 0) {
    sheet.getRange(2, 1, rows, 1).getValues().forEach(function (r) {
      var n = Number(unescapeCell_(r[0]));
      if (n > last) last = n;
    });
  }
  var id = last + 1;
  props.setProperty('LAST_ID', String(id));
  return id;
}

function listOrders_() {
  var sheet = getSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, COLUMNS.length).getValues();
  return values.filter(function (r) { return String(r[0]) !== ''; }).map(rowToOrder_);
}

function rowToOrder_(r) {
  var o = {};
  COLUMNS.forEach(function (c, i) { o[c[0]] = cellToString_(r[i], c[0]); });
  o.status = statusId_(o.status);
  return o;
}

function updateOrder_(id, fields) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getSheet_();
    var rowIndex = findRow_(sheet, id);
    if (!rowIndex) throw codeError_('Заявка не найдена — возможно, её удалили. Обновите список.', 'notfound');

    var set = {};
    if (fields.status != null) {
      if (!STATUSES[fields.status]) throw codeError_('Неизвестный статус', 'validation');
      set.status = STATUSES[fields.status];
    }
    if (fields.price != null) set.price = moneyField_(fields.price);
    if (fields.paid != null) set.paid = moneyField_(fields.paid);
    if (fields.expenses != null) set.expenses = moneyField_(fields.expenses);
    if (fields.notes != null) set.notes = str_(fields.notes, 3000);

    COLUMNS.forEach(function (c, i) {
      if (set.hasOwnProperty(c[0])) {
        var cell = sheet.getRange(rowIndex, i + 1);
        cell.setNumberFormat('@');
        cell.setValue(escapeCell_(set[c[0]]));
      }
    });
    SpreadsheetApp.flush();
    var row = sheet.getRange(rowIndex, 1, 1, COLUMNS.length).getValues()[0];
    return { ok: true, order: rowToOrder_(row) };
  } finally {
    lock.releaseLock();
  }
}

function deleteOrder_(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sheet = getSheet_();
    var rowIndex = findRow_(sheet, id);
    if (!rowIndex) throw codeError_('Заявка не найдена', 'notfound');
    sheet.deleteRow(rowIndex);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function findRow_(sheet, id) {
  id = String(id == null ? '' : id).trim();
  if (!id) return 0;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (cellToString_(ids[i][0], 'id') === id) return i + 2;
  }
  return 0;
}

function moneyField_(v) {
  var s = String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.');
  if (s === '') return '';
  var n = Number(s);
  if (!isFinite(n) || n < 0) throw codeError_('Суммы должны быть числами не меньше нуля', 'validation');
  return String(Math.round(Math.min(n, 1e8)));
}

function statusId_(label) {
  for (var k in STATUSES) {
    if (STATUSES[k] === label || k === label) return k;
  }
  return 'new';
}

/* ===================== Таблица ===================== */

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    var header = sheet.getRange(1, 1, 1, COLUMNS.length);
    header.setValues([COLUMNS.map(function (c) { return c[1]; })]);
    header.setFontWeight('bold').setBackground('#f1ebff');
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, sheet.getMaxRows(), COLUMNS.length).setNumberFormat('@');
  }
  return sheet;
}

/** Защита от формул: значения, начинающиеся с = + - @, записываются как текст. */
function escapeCell_(v) {
  var s = String(v == null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function unescapeCell_(v) {
  var s = String(v == null ? '' : v);
  return /^'[=+\-@]/.test(s) ? s.slice(1) : s;
}

function cellToString_(v, key) {
  if (v instanceof Date) {
    var fmt = key === 'created' ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd';
    return Utilities.formatDate(v, tz_(), fmt);
  }
  return unescapeCell_(v);
}

/* ===================== Telegram ===================== */

function notifyTelegram_(id, clean, calc) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('TG_TOKEN');
  var chatId = props.getProperty('TG_CHAT_ID');
  if (!token || !chatId) return;

  var unit = unitText_(calc.service.unit, clean.volume);
  var lines = [
    '🆕 <b>Новая заявка №' + id + '</b>',
    '',
    '👤 ' + h_(clean.name),
    '📱 ' + h_(clean.contact),
    '📄 ' + h_(calc.service.name) + ', ' + clean.volume + ' ' + h_(unit),
    '📝 Тема: ' + h_(clean.topic),
    '📅 Срок: ' + fmtDate_(clean.deadline) + (calc.urgent ? ' ⚡ срочно' : '')
  ];
  if (clean.subject || clean.grade) {
    lines.push('🎓 ' + h_([clean.subject, clean.grade].filter(String).join(', ')));
  }
  if (calc.options.length) {
    lines.push('➕ Опции: ' + h_(calc.options.map(function (o) { return o.name; }).join(', ')));
  }
  if (clean.wishes) lines.push('💬 Пожелания: ' + h_(clean.wishes));
  lines.push('');
  lines.push('💰 <b>Сумма: ' + formatMoney_(calc.total) + '</b>' +
    (calc.prepay ? ' (предоплата ' + formatMoney_(calc.prepay) + ')' : ''));

  var text = lines.join('\n');
  if (text.length > 4000) text = text.slice(0, 4000) + '…';
  UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true }),
    muteHttpExceptions: true
  });
}

function unitText_(unit, n) {
  var forms = { 'слайд': ['слайд', 'слайда', 'слайдов'] }[unit];
  if (!forms) return unit;
  n = Math.abs(n) % 100;
  var n1 = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}

function h_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatMoney_(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';
}

/* ===================== Помощники ===================== */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(message) { return { ok: false, code: 'validation', error: message }; }

function codeError_(message, code) {
  var e = new Error(message);
  e.code = code;
  return e;
}

function str_(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, max);
}

function clamp_(v, min, max, def) {
  var n = parseFloat(v);
  if (!isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function tz_() {
  return Session.getScriptTimeZone() || 'Europe/Moscow';
}

function todayStr_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
}

function isDateStr_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  var p = s.split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
}

/** Сколько дней от from до to (обе даты — строки YYYY-MM-DD). */
function daysBetween_(from, to) {
  var a = from.split('-').map(Number);
  var b = to.split('-').map(Number);
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 864e5);
}

function fmtDate_(s) {
  var p = String(s).split('-');
  return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : String(s);
}

function md5_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); })
    .join('');
}

/* ===================== Запускаются вручную из редактора ===================== */

/** 1) Создаёт лист «Заказы» и запрашивает разрешения. Запустите один раз. */
function setup() {
  getSheet_();
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('ADMIN_PASSWORD')) {
    console.warn('Не забудьте добавить свойство ADMIN_PASSWORD (Настройки проекта → Свойства скрипта).');
  }
  console.log('Готово: лист «' + SHEET_NAME + '» создан. Текущие цены: ' + JSON.stringify(getConfig_()));
}

/** 2) Проверка уведомлений: отправляет тестовое сообщение в Telegram. */
function testTelegram() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('TG_TOKEN');
  var chatId = props.getProperty('TG_CHAT_ID');
  if (!token || !chatId) throw new Error('Добавьте свойства TG_TOKEN и TG_CHAT_ID.');
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: chatId, text: '✅ Уведомления о заявках подключены!' }),
    muteHttpExceptions: true
  });
  console.log(res.getResponseCode() + ' ' + res.getContentText());
}

/** Подсказка: узнать свой chat_id. Напишите боту /start и запустите эту функцию. */
function showTelegramChatId() {
  var token = PropertiesService.getScriptProperties().getProperty('TG_TOKEN');
  if (!token) throw new Error('Сначала добавьте свойство TG_TOKEN.');
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getUpdates', { muteHttpExceptions: true });
  var data = JSON.parse(res.getContentText());
  var ids = {};
  (data.result || []).forEach(function (u) {
    var m = u.message || u.channel_post;
    if (m && m.chat) ids[m.chat.id] = (m.chat.first_name || m.chat.title || '') + (m.chat.username ? ' @' + m.chat.username : '');
  });
  if (!Object.keys(ids).length) console.log('Сообщений не найдено. Напишите боту /start и запустите функцию ещё раз.');
  Object.keys(ids).forEach(function (id) { console.log('chat_id: ' + id + ' — ' + ids[id]); });
}
