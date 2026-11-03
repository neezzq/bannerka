'use strict';
/*
 * Сервер сайта заказов: отдаёт страницы, принимает заявки, хранит их в JSON-файлах,
 * пускает в админку по паролю из .env и шлёт уведомления в Telegram.
 * Без внешних зависимостей — нужен только Node.js 18+.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'common.js'));

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const TG_TOKEN = String(process.env.TG_TOKEN || '').trim();
const TG_CHAT_IDS = String(process.env.TG_CHAT_ID || '').split(/[\s,;]+/).filter(Boolean);
const SITE_URL = String(process.env.SITE_URL || '').replace(/\/+$/, '');

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ================= Хранилище (JSON-файлы, атомарная запись) ================= */

function readJson(name, def) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Не удалось прочитать', name, e.message);
    return def;
  }
}

function writeJson(name, value) {
  const file = path.join(DATA_DIR, name);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const db = {
  orders: readJson('orders.json', []),
  config: C.normalizeConfig(readJson('config.json', null) || C.DEFAULT_CONFIG),
  meta: readJson('meta.json', { lastId: 0 }),
  bot: readJson('bot.json', { offset: 0, subscribers: [] })
};
if (!Array.isArray(db.orders)) db.orders = [];
db.meta.lastId = Math.max(db.meta.lastId || 0, ...db.orders.map((o) => +o.id || 0), 0);

const saveOrders = () => writeJson('orders.json', db.orders);
const saveConfig = () => writeJson('config.json', db.config);
const saveMeta = () => writeJson('meta.json', db.meta);
const saveBot = () => writeJson('bot.json', db.bot);

/* ================= Пароль и защита от перебора ================= */

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const PW_HASH = sha(ADMIN_PASSWORD);
const PW_TAG = sha('tag:' + ADMIN_PASSWORD).toString('hex').slice(0, 16);

function passwordOk(pw) {
  if (!ADMIN_PASSWORD) return false;
  return crypto.timingSafeEqual(sha(pw), PW_HASH);
}

const fails = new Map(); // ip -> { n, until }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function checkAuth(ip, pw) {
  if (!ADMIN_PASSWORD) throw C.ApiError('Пароль не задан: укажите ADMIN_PASSWORD в файле .env на сервере', 'auth');
  const f = fails.get(ip) || { n: 0, until: 0 };
  if (f.until > Date.now()) throw C.ApiError('Слишком много попыток. Подождите 15 минут.', 'auth');
  if (passwordOk(pw)) { fails.delete(ip); return; }
  f.n += 1;
  if (f.n >= 10) { f.until = Date.now() + 15 * 60e3; f.n = 0; }
  fails.set(ip, f);
  await sleep(Math.min(500 * 2 ** Math.min(f.n, 4), 8000));
  throw C.ApiError('Неверный пароль', 'auth');
}

/* ================= Ограничение частоты заявок ================= */

const hits = new Map(); // key -> [timestamps]
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= limit) { hits.set(key, list); return true; }
  list.push(now);
  hits.set(key, list);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (!v.some((t) => now - t < 3600e3)) hits.delete(k);
  for (const [k, v] of fails) if (v.until < now && v.n === 0) fails.delete(k);
}, 600e3).unref();

/* ================= API ================= */

function normContact(c) {
  return String(c).toLowerCase().replace(/^https?:\/\/(t\.me|telegram\.me)\//, '@').replace(/[^\w@+]/g, '');
}

async function handleApi(p, ip) {
  const action = String(p.action || '');
  switch (action) {
    case 'config':
      return { ok: true, config: db.config };

    case 'order': {
      const o = p.order || {};
      if (o.website) return { ok: true, id: 0, total: 0, prepay: 0 }; // бот заполнил ловушку
      const v = C.validateOrder(o, db.config);
      if (v.error) throw C.ApiError(v.error, 'validation');
      if (rateLimited('ip:' + ip, 10, 3600e3) || rateLimited('c:' + normContact(v.clean.contact), 5, 3600e3)) {
        throw C.ApiError('Слишком много заявок за час. Напишите мне напрямую: ' + (db.config.support || C.SUPPORT), 'rate');
      }
      db.meta.lastId += 1;
      const row = C.buildOrderRow(db.meta.lastId, C.nowStamp(), v.clean, v.calc);
      db.orders.push(row);
      saveMeta();
      saveOrders();
      notifyNewOrder(row, v.calc).catch((e) => console.error('Telegram:', e.message));
      return { ok: true, id: row.id, total: v.calc.total, prepay: v.calc.prepay };
    }

    case 'login':
      await checkAuth(ip, p.password);
      return { ok: true };

    case 'list':
      await checkAuth(ip, p.password);
      return { ok: true, orders: db.orders };

    case 'update': {
      await checkAuth(ip, p.password);
      const order = db.orders.find((x) => x.id === String(p.id));
      if (!order) throw C.ApiError('Заявка не найдена');
      C.applyUpdate(order, p.fields);
      saveOrders();
      return { ok: true, order };
    }

    case 'delete': {
      await checkAuth(ip, p.password);
      db.orders = db.orders.filter((x) => x.id !== String(p.id));
      saveOrders();
      return { ok: true };
    }

    case 'saveConfig':
      await checkAuth(ip, p.password);
      db.config = C.normalizeConfig(p.config);
      saveConfig();
      return { ok: true, config: db.config };

    default:
      throw C.ApiError('Неизвестное действие');
  }
}

/* ================= Telegram ================= */

function tg(method, body) {
  return fetch('https://api.telegram.org/bot' + TG_TOKEN + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(method === 'getUpdates' ? 40e3 : 15e3)
  }).then((r) => r.json()).then((j) => {
    if (!j.ok) throw new Error(method + ': ' + (j.description || 'ошибка'));
    return j.result;
  });
}

const h = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function notifyChats() {
  const subs = (db.bot.subscribers || []).filter((s) => s.tag === PW_TAG).map((s) => String(s.id));
  return [...new Set([...TG_CHAT_IDS, ...subs])];
}

function isTrustedChat(id) { return notifyChats().includes(String(id)); }

function contactLine(contact) {
  const href = C.contactHref(contact);
  return href && href.startsWith('http') ? '<a href="' + h(href) + '">' + h(contact) + '</a>' : h(contact);
}

function orderText(o, title) {
  const dl = C.daysUntil(o.deadline);
  const left = dl == null ? '' : dl === 0 ? ' (сегодня!)' : dl > 0 ? ' (через ' + dl + ' ' + C.plural(dl, ['день', 'дня', 'дней']) + ')' : ' (просрочено)';
  const lines = [
    '<b>' + h(title) + ' №' + h(o.id) + '</b> · ' + h(C.statusLabel(o.status)),
    '',
    '👤 ' + h(o.name) + ' — ' + contactLine(o.contact),
    '📄 <b>' + h(o.service) + '</b>' + (o.volume ? ', ' + h(o.volume) : ''),
    '📝 ' + h(o.topic)
  ];
  if (o.subject || o.grade) lines.push('🎓 ' + h([o.subject, o.grade].filter(Boolean).join(', ')));
  lines.push('📅 Срок: ' + h(C.fmtDate(o.deadline)) + h(left));
  if (o.options) lines.push('➕ ' + h(o.options));
  if (o.wishes) lines.push('💬 ' + h(o.wishes));
  lines.push('💰 ' + h(C.money(o.price || o.calcPrice)) + (o.paid ? ' · оплачено ' + h(C.money(o.paid)) : ''));
  if (o.notes) lines.push('🗒 ' + h(o.notes));
  return lines.join('\n');
}

function orderButtons(o) {
  const row = [['work', 'В работу'], ['done', 'Сдан'], ['cancelled', 'Отменить']]
    .filter(([st]) => st !== o.status)
    .map(([st, label]) => ({ text: label, callback_data: 'st:' + o.id + ':' + st }));
  const kb = [row];
  if (SITE_URL) kb.push([{ text: 'Открыть админку', url: SITE_URL + '/admin.html' }]);
  return { inline_keyboard: kb };
}

async function notifyNewOrder(o) {
  if (!TG_TOKEN) return;
  const chats = notifyChats();
  if (!chats.length) { console.warn('Telegram: некому отправлять. Напишите боту /login пароль'); return; }
  for (const chat_id of chats) {
    await tg('sendMessage', {
      chat_id, text: orderText(o, '🆕 Новая заявка'), parse_mode: 'HTML',
      disable_web_page_preview: true, reply_markup: orderButtons(o)
    }).catch((e) => console.error('Telegram →', chat_id, e.message));
  }
}

const HELP = [
  'Команды:',
  '/login <i>пароль</i> — получать уведомления о заявках',
  '/orders — активные заявки',
  '/logout — отключить уведомления'
].join('\n');

async function onMessage(m) {
  const chatId = m.chat.id;
  const text = String(m.text || '').trim();
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = (cmdRaw || '').toLowerCase().replace(/@\w+$/, '');
  const reply = (t, extra) => tg('sendMessage', Object.assign({ chat_id: chatId, text: t, parse_mode: 'HTML', disable_web_page_preview: true }, extra));

  if (cmd === '/login') {
    if (m.chat.type === 'private') tg('deleteMessage', { chat_id: chatId, message_id: m.message_id }).catch(() => {});
    if (!ADMIN_PASSWORD) return reply('На сервере не задан ADMIN_PASSWORD.');
    if (!passwordOk(rest.join(' '))) { await sleep(1500); return reply('Неверный пароль.'); }
    db.bot.subscribers = (db.bot.subscribers || []).filter((s) => String(s.id) !== String(chatId));
    db.bot.subscribers.push({ id: chatId, tag: PW_TAG, name: m.chat.title || m.chat.first_name || '' });
    saveBot();
    return reply('✅ Готово! Новые заявки будут приходить сюда.\n\n' + HELP);
  }
  if (cmd === '/logout') {
    db.bot.subscribers = (db.bot.subscribers || []).filter((s) => String(s.id) !== String(chatId));
    saveBot();
    return reply('Уведомления отключены.');
  }
  if (cmd === '/orders') {
    if (!isTrustedChat(chatId)) return reply('Сначала войдите: /login <i>пароль</i>');
    const active = db.orders.filter((o) => C.ACTIVE_STATUSES.includes(o.status))
      .sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
    if (!active.length) return reply('Активных заявок нет 🎉');
    for (const o of active.slice(0, 15)) {
      await reply(orderText(o, 'Заявка'), { reply_markup: orderButtons(o) });
    }
    if (active.length > 15) await reply('…и ещё ' + (active.length - 15) + '. Все — в админке.');
    return;
  }
  // /start и всё остальное
  return reply(
    'Привет! Я присылаю уведомления о новых заявках с сайта.\n\n' +
    'Ваш chat_id: <code>' + chatId + '</code>\n\n' + HELP
  );
}

async function onCallback(q) {
  const chatId = q.message && q.message.chat.id;
  const ans = (text) => tg('answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => {});
  if (!isTrustedChat(chatId)) return ans('Нет доступа. Войдите: /login пароль');
  const m = /^st:(\d+):(\w+)$/.exec(q.data || '');
  if (!m) return ans('Неизвестная команда');
  const order = db.orders.find((o) => o.id === m[1]);
  if (!order) return ans('Заявка не найдена (возможно, удалена)');
  try { C.applyUpdate(order, { status: m[2] }); } catch (e) { return ans(e.message); }
  saveOrders();
  await ans('Статус: ' + C.statusLabel(order.status));
  await tg('editMessageText', {
    chat_id: chatId, message_id: q.message.message_id,
    text: orderText(order, 'Заявка'), parse_mode: 'HTML', disable_web_page_preview: true,
    reply_markup: orderButtons(order)
  }).catch(() => {});
}

async function pollTelegram() {
  if (!TG_TOKEN) { console.log('Telegram: TG_TOKEN не задан — уведомления выключены'); return; }
  try {
    const me = await tg('getMe');
    console.log('Telegram: бот @' + me.username + ' запущен');
    await tg('deleteWebhook', {}).catch(() => {});
  } catch (e) {
    console.error('Telegram: проверьте TG_TOKEN —', e.message);
  }
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset: db.bot.offset || 0, timeout: 30, allowed_updates: ['message', 'callback_query'] });
      for (const u of updates) {
        db.bot.offset = u.update_id + 1;
        try {
          if (u.message && u.message.text) await onMessage(u.message);
          else if (u.callback_query) await onCallback(u.callback_query);
        } catch (e) { console.error('Telegram update:', e.message); }
      }
      if (updates.length) saveBot();
    } catch (e) {
      console.error('Telegram poll:', e.message);
      await sleep(5000);
    }
  }
}

/* ================= HTTP: статика + /api ================= */

const STATIC = {
  '/index.html': 'index.html', '/admin.html': 'admin.html', '/app.css': 'app.css',
  '/common.js': 'common.js', '/config.js': 'config.js', '/sw.js': 'sw.js',
  '/manifest.json': 'manifest.json', '/admin-manifest.json': 'admin-manifest.json'
};
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon'
};

function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  const local = /^(::1|127\.|::ffff:127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::ffff:(10|192\.168|172)\.)/.test(remote);
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return local && xff ? xff : remote;
}

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY'
  }, headers));
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

function serveStatic(req, res, pathname) {
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  if (pathname === '/admin' || pathname === '/admin/') pathname = '/admin.html';
  let rel = STATIC[pathname];
  if (!rel && /^\/icons\/[\w.-]+\.png$/.test(pathname)) rel = pathname.slice(1);
  if (!rel && pathname === '/favicon.ico') rel = 'icons/icon-192.png';
  if (!rel) return send(res, 404, 'Не найдено', { 'Content-Type': 'text/plain; charset=utf-8' });

  const file = path.join(ROOT, rel);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Не найдено', { 'Content-Type': 'text/plain; charset=utf-8' });
    const etag = '"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    const headers = {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': rel.startsWith('icons/') ? 'public, max-age=86400' : 'no-cache',
      ETag: etag
    };
    if (rel === 'admin.html') headers['X-Robots-Tag'] = 'noindex, nofollow';
    if (req.headers['if-none-match'] === etag) return send(res, 304, '', headers);
    if (req.method === 'HEAD') return send(res, 200, '', headers);
    fs.readFile(file, (e2, buf) => e2 ? send(res, 500, 'Ошибка') : send(res, 200, buf, headers));
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { return send(res, 400, 'Bad request'); }

  if (pathname === '/api' || pathname === '/api/') {
    if (req.method === 'GET') return sendJson(res, 200, { ok: true, message: 'API работает' });
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Метод не поддерживается' });
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { sendJson(res, 413, { ok: false, error: 'Слишком большой запрос' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) {
        return sendJson(res, 400, { ok: false, error: 'Неверный формат запроса' });
      }
      try {
        sendJson(res, 200, await handleApi(payload || {}, clientIp(req)));
      } catch (e) {
        if (!e.code) console.error('API', payload && payload.action, e);
        const status = e.code === 'auth' ? 401 : e.code === 'rate' ? 429 : 400;
        sendJson(res, status, { ok: false, error: e.code ? e.message : (e.message || 'Ошибка сервера'), code: e.code || '' });
      }
    });
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log('Сайт запущен: http://' + HOST + ':' + PORT + ' · данные: ' + DATA_DIR);
  if (!ADMIN_PASSWORD) console.warn('ВНИМАНИЕ: ADMIN_PASSWORD не задан — вход в админку невозможен');
  pollTelegram();
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); process.exit(0); });
