/*
 * Общая логика клиентского сайта и админки:
 * расчёт цены, вызовы API, демо-режим, мелкие помощники.
 */
(function () {
  'use strict';

  var IS_BROWSER = typeof window !== 'undefined' && typeof document !== 'undefined';
  var CFG = (IS_BROWSER && window.APP_CONFIG) || {};
  var API_URL = String(CFG.API_URL || '').trim();
  var DEMO = IS_BROWSER && !API_URL;

  /* ---------- Настройки по умолчанию ---------- */

  var SUPPORT = '@neezzy';

  var DEFAULT_CONFIG = {
    eyebrow: 'Принимаю заказы',
    heroTitle: 'Доклады и презентации на заказ',
    heroSubtitle: 'Сделаю доклад, презентацию или текст выступления точно к сроку. Ориентировочную цену видно сразу.',
    steps: [
      { title: 'Заполните заявку', sub: 'Цена посчитается сразу' },
      { title: 'Я свяжусь с вами', sub: 'Обсудим детали и цену' },
      { title: 'Получите работу', sub: 'Точно к нужной дате' }
    ],
    pricesText: 'Цены ориентировочные — за весь проект целиком. Выберите услугу — она подставится в заявку.',
    contact: SUPPORT,
    support: SUPPORT,
    note: 'Цена ориентировочная — точную сумму подтвержу, когда обсудим детали.',
    footerText: 'Доклады и презентации на заказ',
    inn: '300204777467',
    services: [
      { id: 'report', name: 'Доклад', price: 1000,
        desc: 'Структурированный текст: введение, основная часть, выводы и список источников.' },
      { id: 'slides', name: 'Презентация', price: 1200,
        desc: 'Современный аккуратный дизайн, схемы и иллюстрации, минимум текста на слайдах.' },
      { id: 'combo', name: 'Доклад + презентация', price: 2000,
        desc: 'Доклад и презентация к нему в едином стиле.' },
      { id: 'speech', name: 'Текст выступления', price: 600,
        desc: 'Текст, который удобно читать вслух, под нужную длительность выступления.' }
    ],
    options: [
      { id: 'plagiarism', name: 'Антиплагиат + отчёт', price: 200 },
      { id: 'notes', name: 'Заметки докладчика', price: 300 }
    ],
    urgency: { days: 3, percent: 30 },
    prepay: 0
  };

  var STATUSES = [
    { id: 'new', label: 'Новый' },
    { id: 'work', label: 'В работе' },
    { id: 'revision', label: 'На правках' },
    { id: 'done', label: 'Сдан' },
    { id: 'cancelled', label: 'Отменён' }
  ];
  var ACTIVE_STATUSES = ['new', 'work', 'revision'];

  /* ---------- Мелкие помощники ---------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function num(v) {
    var n = parseFloat(String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.'));
    return isFinite(n) ? n : 0;
  }

  function clampNum(v, min, max, def) {
    var n = parseFloat(v);
    if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  }

  function str(v, max) {
    return String(v == null ? '' : v)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim()
      .slice(0, max);
  }

  function round10(n) { return Math.round(n / 10) * 10; }

  function money(n) {
    return Math.round(num(n)).toLocaleString('ru-RU') + ' ₽';
  }

  function plural(n, forms) {
    n = Math.abs(Math.floor(n)) % 100;
    var n1 = n % 10;
    if (n > 10 && n < 20) return forms[2];
    if (n1 > 1 && n1 < 5) return forms[1];
    if (n1 === 1) return forms[0];
    return forms[2];
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function addDays(dateStr, days) {
    var p = dateStr.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function isDateStr(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
    var p = s.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
  }

  /** Сколько дней от сегодня до даты (0 — сегодня, отрицательное — прошло). */
  function daysUntil(dateStr, today) {
    if (!isDateStr(dateStr)) return null;
    today = today || todayStr();
    var a = dateStr.split('-').map(Number);
    var b = today.split('-').map(Number);
    return Math.round((Date.UTC(a[0], a[1] - 1, a[2]) - Date.UTC(b[0], b[1] - 1, b[2])) / 864e5);
  }

  function fmtDate(dateStr) {
    if (!dateStr) return '';
    var m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[3] + '.' + m[2] + '.' + m[1] : String(dateStr);
  }

  function uid(prefix) {
    return (prefix || 'id') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /** Ссылка для контакта: @ник → t.me, телефон → tel: */
  function contactHref(contact) {
    var c = String(contact || '').trim();
    var tme = c.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{4,32})\/?$/i);
    if (tme) return 'https://t.me/' + tme[1];
    var nick = c.match(/^@([A-Za-z0-9_]{4,32})$/);
    if (nick) return 'https://t.me/' + nick[1];
    var digits = c.replace(/[^\d]/g, '');
    if (/^[+\d\s()\-]+$/.test(c) && digits.length >= 10 && digits.length <= 15) {
      if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);
      return 'tel:+' + digits;
    }
    if (/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(c)) return 'https://t.me/' + c;
    return '';
  }

  /* ---------- Настройки: проверка и нормализация ---------- */

  function normalizeConfig(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    var d = DEFAULT_CONFIG;
    var usedIds = {};
    function cleanId(id, prefix) {
      id = String(id || '').replace(/[^\w-]/g, '').slice(0, 40);
      if (!id || usedIds[id]) id = uid(prefix);
      usedIds[id] = true;
      return id;
    }
    var services = (Array.isArray(raw.services) ? raw.services : d.services).slice(0, 30).map(function (s) {
      s = s || {};
      return {
        id: cleanId(s.id, 's'),
        name: str(s.name, 80),
        price: Math.round(clampNum(s.price, 0, 1e7, 0)),
        desc: str(s.desc, 400)
      };
    }).filter(function (s) { return s.name; });
    if (!services.length) services = JSON.parse(JSON.stringify(d.services));

    var options = (Array.isArray(raw.options) ? raw.options : d.options).slice(0, 20).map(function (o) {
      o = o || {};
      return { id: cleanId(o.id, 'o'), name: str(o.name, 80), price: Math.round(clampNum(o.price, 0, 1e6, 0)) };
    }).filter(function (o) { return o.name; });

    var rawSteps = Array.isArray(raw.steps) ? raw.steps : d.steps;
    var steps = [0, 1, 2].map(function (i) {
      var st = rawSteps[i] || {};
      return { title: str(st.title, 60), sub: str(st.sub, 100) };
    });

    var u = raw.urgency || d.urgency;
    function text(key, max) { return raw[key] == null ? d[key] : str(raw[key], max); }
    return {
      eyebrow: text('eyebrow', 60),
      heroTitle: text('heroTitle', 120),
      heroSubtitle: text('heroSubtitle', 400),
      steps: steps,
      pricesText: text('pricesText', 300),
      contact: text('contact', 100),
      support: text('support', 100),
      note: text('note', 600),
      footerText: text('footerText', 200),
      inn: String(raw.inn == null ? d.inn : raw.inn).replace(/\D/g, '').slice(0, 12),
      services: services,
      options: options,
      urgency: {
        days: Math.round(clampNum(u.days, 0, 60, d.urgency.days)),
        percent: Math.round(clampNum(u.percent, 0, 500, d.urgency.percent))
      },
      prepay: Math.round(clampNum(raw.prepay, 0, 100, d.prepay)),
      // Включена ли онлайн-оплата — решает сервер (есть ли ключи ЮKassa), из админки не меняется.
      payEnabled: raw.payEnabled === true
    };
  }

  /* ---------- Расчёт цены (этот же код работает на сервере) ---------- */

  /**
   * Цена услуги — ориентировочная, за весь проект.
   * input: { serviceId, deadline: 'YYYY-MM-DD', options: [id, ...] }
   */
  function calcPrice(config, input, today) {
    var service = null;
    for (var i = 0; i < config.services.length; i++) {
      if (config.services[i].id === input.serviceId) service = config.services[i];
    }
    if (!service) return { ok: false, service: null };

    var base = service.price;
    var chosen = config.options.filter(function (o) {
      return (input.options || []).indexOf(o.id) !== -1;
    });
    var optionsSum = chosen.reduce(function (s, o) { return s + o.price; }, 0);

    var daysLeft = input.deadline ? daysUntil(input.deadline, today) : null;
    var urgent = daysLeft !== null && daysLeft >= 0 && config.urgency.percent > 0 && daysLeft < config.urgency.days;
    var urgencySum = urgent ? Math.round(base * config.urgency.percent / 100) : 0;

    var total = round10(base + optionsSum + urgencySum);
    var prepay = round10(total * config.prepay / 100);
    return {
      ok: true, service: service, base: base, options: chosen, optionsSum: optionsSum,
      daysLeft: daysLeft, urgent: urgent, urgencySum: urgencySum,
      total: total, prepay: prepay
    };
  }

  /* ---------- Проверка заявки (этот же код работает на сервере) ---------- */

  function validateOrder(o, config, today) {
    o = o || {};
    today = today || todayStr();
    var clean = {
      name: str(o.name, 100),
      contact: str(o.contact, 100),
      serviceId: str(o.serviceId, 40),
      topic: str(o.topic, 300),
      volume: str(o.volume, 100),
      deadline: str(o.deadline, 10),
      subject: str(o.subject, 100),
      grade: str(o.grade, 50),
      wishes: str(o.wishes, 2000),
      options: (Array.isArray(o.options) ? o.options : []).map(function (x) { return str(x, 40); })
    };
    if (!clean.name) return { error: 'Укажите имя' };
    if (clean.contact.length < 3) return { error: 'Укажите Telegram или телефон' };
    if (!config.services.some(function (s) { return s.id === clean.serviceId; })) return { error: 'Выберите услугу' };
    if (!clean.topic) return { error: 'Укажите тему' };
    if (!isDateStr(clean.deadline)) return { error: 'Укажите дату, к которой нужна работа' };
    var dl = daysUntil(clean.deadline, today);
    if (dl < 0) return { error: 'Дата не может быть раньше сегодняшней' };
    if (dl > 730) return { error: 'Слишком далёкая дата' };
    clean.options = config.options.filter(function (x) { return clean.options.indexOf(x.id) !== -1; }).map(function (x) { return x.id; });
    var calc = calcPrice(config, clean, today);
    return { clean: clean, calc: calc };
  }

  var ORDER_FIELDS = ['id', 'created', 'name', 'contact', 'service', 'volume', 'topic', 'subject', 'grade',
    'deadline', 'options', 'wishes', 'calcPrice', 'status', 'price', 'paid', 'expenses', 'notes', 'payToken', 'payLog'];

  function statusLabel(id) {
    for (var i = 0; i < STATUSES.length; i++) if (STATUSES[i].id === id) return STATUSES[i].label;
    return id;
  }

  function nowStamp() {
    var d = new Date();
    return todayStr() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function buildOrderRow(id, created, clean, calc) {
    return {
      id: String(id), created: created,
      name: clean.name, contact: clean.contact,
      service: calc.service.name, volume: clean.volume,
      topic: clean.topic, subject: clean.subject, grade: clean.grade,
      deadline: clean.deadline,
      options: calc.options.map(function (o) { return o.name; }).join(', '),
      wishes: clean.wishes, calcPrice: String(calc.total),
      status: 'new', price: String(calc.total), paid: '', expenses: '', notes: '',
      payToken: '', payLog: ''
    };
  }

  /** Сколько осталось оплатить онлайн: вся цена заказа минус уже оплаченное. */
  function payAmounts(order) {
    var price = Math.round(num(order.price || order.calcPrice));
    var paid = Math.round(num(order.paid));
    return { price: price, paid: paid, rest: Math.max(0, price - paid) };
  }

  function ApiError(message, code) {
    var e = new Error(message);
    e.code = code || '';
    return e;
  }

  function moneyField(v) {
    var s = String(v == null ? '' : v).replace(/\s/g, '').replace(',', '.');
    if (s === '') return '';
    var n = parseFloat(s);
    if (!isFinite(n) || n < 0) throw ApiError('Суммы должны быть числами не меньше нуля', 'validation');
    return String(Math.round(Math.min(n, 1e8)));
  }

  function applyUpdate(order, f) {
    f = f || {};
    if (f.status != null) {
      if (!STATUSES.some(function (s) { return s.id === f.status; })) throw ApiError('Неизвестный статус', 'validation');
      order.status = f.status;
    }
    if (f.price != null) order.price = moneyField(f.price);
    if (f.paid != null) order.paid = moneyField(f.paid);
    if (f.expenses != null) order.expenses = moneyField(f.expenses);
    if (f.notes != null) order.notes = str(f.notes, 3000);
  }

  var shared = {
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    SUPPORT: SUPPORT,
    STATUSES: STATUSES,
    ACTIVE_STATUSES: ACTIVE_STATUSES,
    ORDER_FIELDS: ORDER_FIELDS,
    normalizeConfig: normalizeConfig,
    calcPrice: calcPrice,
    validateOrder: validateOrder,
    buildOrderRow: buildOrderRow,
    payAmounts: payAmounts,
    applyUpdate: applyUpdate,
    ApiError: ApiError,
    statusLabel: statusLabel,
    esc: esc, num: num, str: str, money: money, plural: plural,
    todayStr: todayStr, nowStamp: nowStamp, addDays: addDays, daysUntil: daysUntil, fmtDate: fmtDate,
    isDateStr: isDateStr, contactHref: contactHref, uid: uid, pad: pad
  };

  // На сервере (Node.js) браузерная часть не нужна.
  if (!IS_BROWSER) {
    if (typeof module !== 'undefined' && module.exports) module.exports = shared;
    return;
  }

  /* ---------- Хранилище браузера ---------- */

  function lsGet(key, def) {
    try {
      var v = localStorage.getItem(key);
      return v == null ? def : JSON.parse(v);
    } catch (e) { return def; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* приватный режим */ }
  }
  function lsDel(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  /* ---------- API ---------- */

  function api(action, data) {
    var payload = Object.assign({ action: action }, data || {});
    if (DEMO) return demoApi(payload);
    return fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store'
    })
      .catch(function () {
        throw ApiError('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.', 'network');
      })
      .then(function (res) {
        return res.json().catch(function () {
          throw ApiError('Сервер ответил ошибкой (' + res.status + ')', 'http');
        });
      })
      .then(function (json) {
        if (!json || !json.ok) throw ApiError((json && json.error) || 'Ошибка сервера', json && json.code);
        return json;
      });
  }

  var CONFIG_CACHE_KEY = 'zk_config_cache_v2';

  /** Сразу отдаёт сохранённые настройки, затем подгружает свежие. */
  function loadConfig(onConfig) {
    var cached = lsGet(CONFIG_CACHE_KEY, null);
    var first = normalizeConfig(cached || DEFAULT_CONFIG);
    onConfig(first, false);
    return api('config').then(function (res) {
      var cfg = normalizeConfig(res.config);
      lsSet(CONFIG_CACHE_KEY, cfg);
      onConfig(cfg, true);
      return cfg;
    }).catch(function (e) {
      console.warn('Не удалось загрузить цены:', e);
      return first;
    });
  }

  /* ---------- Демо-режим (всё в localStorage, когда API_URL пустой) ---------- */

  var DEMO_ORDERS = 'zk_demo_orders_v2';
  var DEMO_CONFIG = 'zk_demo_config_v2';
  var DEMO_PASSWORD = 'demo';

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function demoSeed(cfg) {
    var t = todayStr();
    var samples = [
      [-24, { name: 'Мария', contact: '@maria_k', serviceId: 'combo', topic: 'Возобновляемые источники энергии', volume: '12 страниц', subject: 'Физика', grade: '10 класс', options: ['plagiarism'] }, -14, { status: 'done', paid: 'full', expenses: '0' }],
      [-9, { name: 'Игорь', contact: '+7 912 345-67-89', serviceId: 'slides', topic: 'История развития интернета', volume: '15 слайдов', subject: 'Информатика', grade: '2 курс', options: ['notes'] }, -2, { status: 'done', paid: 'full', expenses: '150', notes: 'Шаблон купил отдельно' }],
      [-3, { name: 'Анна', contact: '@anna_study', serviceId: 'report', topic: 'Творчество А. С. Пушкина', volume: '8 страниц', subject: 'Литература', grade: '9 класс', options: [] }, 2, { status: 'work', paid: 'half' }],
      [-1, { name: 'Дмитрий', contact: '@dima_pro', serviceId: 'speech', topic: 'Защита курсового проекта', volume: '7 минут', subject: 'Экономика', grade: '3 курс', options: [], wishes: 'Спокойный деловой стиль' }, 6, { status: 'new' }]
    ];
    return samples.map(function (s, i) {
      var created = addDays(t, s[0]);
      var input = Object.assign({ deadline: addDays(t, s[2]), wishes: '' }, s[1]);
      var calc = calcPrice(cfg, input, created);
      if (!calc.ok) return null;
      var row = buildOrderRow(i + 1, created + ' ' + pad(10 + i) + ':' + pad(i * 7), input, calc);
      row.status = s[3].status;
      if (s[3].paid === 'full') row.paid = String(calc.total);
      if (s[3].paid === 'half') row.paid = String(calc.prepay);
      if (s[3].expenses) row.expenses = s[3].expenses;
      if (s[3].notes) row.notes = s[3].notes;
      return row;
    }).filter(Boolean);
  }

  function demoConfig() { return normalizeConfig(lsGet(DEMO_CONFIG, null) || DEFAULT_CONFIG); }

  function demoOrders() {
    var list = lsGet(DEMO_ORDERS, null);
    if (!Array.isArray(list)) {
      list = demoSeed(demoConfig());
      lsSet(DEMO_ORDERS, list);
    }
    return list;
  }

  function demoApi(p) {
    return delay(250).then(function () {
      var needAuth = ['list', 'update', 'delete', 'saveConfig', 'login'].indexOf(p.action) !== -1;
      if (needAuth && p.password !== DEMO_PASSWORD) {
        return delay(800).then(function () { throw ApiError('Неверный пароль (в демо-режиме пароль: demo)', 'auth'); });
      }
      var cfg = demoConfig();
      var orders, i;
      switch (p.action) {
        case 'config':
          return { ok: true, config: cfg };
        case 'login':
          return { ok: true };
        case 'order': {
          var o = p.order || {};
          if (o.website) return { ok: true, id: 0, total: 0, prepay: 0 };
          var v = validateOrder(o, cfg);
          if (v.error) throw ApiError(v.error, 'validation');
          orders = demoOrders();
          var nextId = orders.reduce(function (m, x) { return Math.max(m, +x.id || 0); }, 0) + 1;
          orders.push(buildOrderRow(nextId, nowStamp(), v.clean, v.calc));
          lsSet(DEMO_ORDERS, orders);
          return { ok: true, id: nextId, total: v.calc.total, prepay: v.calc.prepay };
        }
        case 'list':
          return { ok: true, orders: demoOrders() };
        case 'update': {
          orders = demoOrders();
          for (i = 0; i < orders.length; i++) {
            if (orders[i].id === String(p.id)) {
              applyUpdate(orders[i], p.fields || {});
              lsSet(DEMO_ORDERS, orders);
              return { ok: true, order: orders[i] };
            }
          }
          throw ApiError('Заявка не найдена');
        }
        case 'delete':
          orders = demoOrders().filter(function (x) { return x.id !== String(p.id); });
          lsSet(DEMO_ORDERS, orders);
          return { ok: true };
        case 'saveConfig': {
          var saved = normalizeConfig(p.config);
          lsSet(DEMO_CONFIG, saved);
          return { ok: true, config: saved };
        }
        default:
          throw ApiError('Неизвестное действие');
      }
    });
  }

  /* ---------- Интерфейс: плашка демо, тосты, подсказка iOS, service worker ---------- */

  function mountDemoBanner() {
    if (!DEMO) return;
    var b = document.createElement('div');
    b.className = 'demo-banner';
    b.innerHTML = '<b>Демо-режим</b> — данные хранятся только в этом браузере. Заполните API_URL в config.js.';
    document.body.insertBefore(b, document.body.firstChild);
    document.documentElement.classList.add('is-demo');
  }

  var toastTimer;
  function toast(message, type) {
    var el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.className = 'toast show' + (type ? ' toast-' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast' + (type ? ' toast-' + type : ''); }, type === 'error' ? 4500 : 2200);
  }

  function isStandalone() {
    return window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  }

  function isIosSafari() {
    var ua = navigator.userAgent || '';
    var iOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    var otherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|GSA|Instagram|FBAN|FBAV|Telegram/i.test(ua);
    return iOS && !otherBrowser && /Safari/i.test(ua);
  }

  var SHARE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';

  function showIosInstallHint(storageKey, appName) {
    if (!isIosSafari() || isStandalone() || lsGet(storageKey, false)) return;
    var el = document.createElement('div');
    el.className = 'ios-hint';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Как установить приложение');
    el.innerHTML =
      '<div class="ios-hint-icon"><img src="' + esc(document.querySelector('link[rel="apple-touch-icon"]').getAttribute('href')) + '" alt=""></div>' +
      '<div class="ios-hint-text"><b>Установите «' + esc(appName) + '» на iPhone</b>' +
      '<span>Нажмите <span class="ios-share">' + SHARE_ICON + '</span> «Поделиться» → «На экран „Домой“»</span></div>' +
      '<button type="button" class="ios-hint-close" aria-label="Закрыть">×</button>';
    el.querySelector('button').addEventListener('click', function () {
      lsSet(storageKey, true);
      el.remove();
    });
    document.body.appendChild(el);
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('SW:', e); });
      });
    }
  }

  registerServiceWorker();

  window.App = Object.assign({}, shared, {
    DEMO: DEMO,
    api: api,
    loadConfig: loadConfig,
    lsGet: lsGet, lsSet: lsSet, lsDel: lsDel,
    mountDemoBanner: mountDemoBanner, toast: toast,
    showIosInstallHint: showIosInstallHint, isStandalone: isStandalone
  });
})();
