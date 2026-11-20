// Проверка server.mjs без сети: поднимаем сервер на случайном порту и
// ходим в него fetch'ем. Telegram подменяем заглушкой через подмену
// глобального fetch — настоящий запрос не уходит никогда.
//
// Запуск: node tools/test-server.js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';

const results = [];
function check(name, fn) {
  try { fn(); results.push(['OK  ', name]); }
  catch (e) { results.push(['FAIL', name + ' — ' + e.message]); }
}

/** Свободный порт от ОС. */
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const PORT = await freePort();

// Тестовый бот: поднимаем свой мини-сервер, который отвечает как Telegram.
const telegram = net.createServer();
let telegramCalls = [];
await new Promise((r) => telegram.listen(0, '127.0.0.1', r));
const TG_PORT = telegram.address().port;
telegram.on('connection', (sock) => {
  sock.on('data', (buf) => {
    const raw = buf.toString();
    telegramCalls.push(raw);
    const body = JSON.stringify({ ok: true, result: { message_id: 42 } });
    sock.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
  });
});

// Подменяем api.telegram.org на локальный сокет через переменную apiBase
// нельзя (в api/telegram.js адрес зашит), поэтому поднимаем сервер с
// подменой globalThis.fetch через NODE_OPTIONS-независимый приём:
// запускаем дочерний процесс с предзагрузкой нашего шима.
const shim = `
import http from 'node:http';
const real = globalThis.fetch;
const TG = 'http://127.0.0.1:${TG_PORT}';
globalThis.fetch = (url, init) => {
  const u = String(url);
  if (u.startsWith('https://api.telegram.org')) {
    return real(u.replace('https://api.telegram.org', TG), init);
  }
  return real(url, init);
};
`;
await import('node:fs/promises').then((fsp) => fsp.writeFile('.shim.mjs', shim));

const child = spawn(process.execPath, ['--import', './.shim.mjs', 'server.mjs'], {
  env: { ...process.env, PORT: String(PORT), TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

// Ждём, пока сервер скажет, что слушает.
for (let i = 0; i < 60; i++) {
  if (out.includes('слушает')) break;
  await new Promise((r) => setTimeout(r, 100));
}

const base = `http://127.0.0.1:${PORT}`;
const get = (p, init) => fetch(base + p, init);

try {
  // ── статика ──────────────────────────────────────────────────────────
  let r = await get('/');
  check('GET / → 200', () => assert.equal(r.status, 200));
  const html = await r.text();
  check('GET / отдаёт наш index.html', () => assert.match(html, /data-price-mode/));
  check('GET / → Content-Type html', () => assert.match(r.headers.get('content-type'), /text\/html/));
  check('GET / → nosniff', () => assert.equal(r.headers.get('x-content-type-options'), 'nosniff'));
  check('GET / → ETag есть', () => assert.ok(r.headers.get('etag')));

  r = await get('/css/style.css');
  check('GET /css/style.css → 200 css', () => {
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/css/);
  });

  r = await get('/js/config.js');
  check('GET /js/config.js → 200 js', () => {
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /javascript/);
  });

  r = await get('/admin.html');
  check('GET /admin.html → 200', () => assert.equal(r.status, 200));

  // ── политика кэша ────────────────────────────────────────────────────
  //
  // Регрессия, которая уже случалась: config.js отдавался с max-age=86400,
  // браузер сутки держал старые настройки, и после смены телефонов сайт
  // показывал неактивные кнопки мессенджеров при верном файле на сервере.
  r = await get('/js/config.js');
  check('config.js не кэшируется надолго (no-cache)', () => {
    assert.equal(r.headers.get('cache-control'), 'no-cache');
  });

  r = await get('/js/main.js');
  check('js/ отдаётся с no-cache', () => {
    assert.equal(r.headers.get('cache-control'), 'no-cache');
  });

  r = await get('/css/style.css');
  check('css/ отдаётся с no-cache', () => {
    assert.equal(r.headers.get('cache-control'), 'no-cache');
  });

  r = await get('/');
  check('index.html перепроверяется (max-age=0)', () => {
    assert.match(r.headers.get('cache-control'), /max-age=0/);
  });

  r = await get('/assets/favicon.svg');
  check('картинки кэшируются надолго', () => {
    assert.match(r.headers.get('cache-control'), /max-age=86400/);
  });

  // ── 304 ──────────────────────────────────────────────────────────────
  const css = await get('/css/style.css');
  const etag = css.headers.get('etag');
  r = await get('/css/style.css', { headers: { 'If-None-Match': etag } });
  check('повторный запрос с ETag → 304', () => assert.equal(r.status, 304));

  // ── закрытые пути ────────────────────────────────────────────────────
  for (const p of ['/.git/config', '/server.mjs', '/package.json', '/api/telegram.js', '/tools/cdp.mjs']) {
    r = await get(p);
    check(`закрыт ${p}`, () => assert.equal(r.status, 404));
  }

  r = await get('/%2e%2e/%2e%2e/windows/win.ini');
  check('выход за корень через %2e%2e → не 200', () => assert.notEqual(r.status, 200));

  r = await get('/../../etc/passwd');
  check('выход за корень через ../ → не 200', () => assert.notEqual(r.status, 200));

  r = await get('/нет-такого-файла');
  check('несуществующий путь → 404', () => assert.equal(r.status, 404));

  // ── API ──────────────────────────────────────────────────────────────
  r = await get('/api/other');
  check('чужой /api/... → 404 json', async () => {
    assert.equal(r.status, 404);
  });

  r = await get('/api/telegram', { method: 'GET' });
  check('GET /api/telegram → 405', () => assert.equal(r.status, 405));

  telegramCalls = [];
  r = await get('/api/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch: 'am', text: 'Тест заявки' }),
  });
  const body = await r.json();
  check('POST /api/telegram → 200 ok', () => {
    assert.equal(r.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.messageId, 42);
  });
  check('POST /api/telegram реально сходил в Telegram', () => {
    assert.equal(telegramCalls.length, 1);
    assert.match(telegramCalls[0], /Тест заявки/);
  });

  r = await get('/api/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch: 'xx', text: 'тест' }),
  });
  check('неверный branch → 400', () => assert.equal(r.status, 400));

  r = await get('/api/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'x'.repeat(20000),
  });
  check('огромное тело → 413', () => assert.equal(r.status, 413));

  r = await get('/api/telegram', { method: 'DELETE' });
  check('DELETE /api/telegram → 405', () => assert.equal(r.status, 405));

  // ── POST на статику ──────────────────────────────────────────────────
  r = await get('/', { method: 'POST' });
  check('POST / → 405', () => assert.equal(r.status, 405));

  // ── HEAD ─────────────────────────────────────────────────────────────
  r = await get('/css/style.css', { method: 'HEAD' });
  check('HEAD /css/style.css → 200 без тела', () => {
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-length') !== null, true);
  });
} finally {
  child.kill('SIGTERM');
  telegram.close();
  await import('node:fs/promises').then((fsp) => fsp.unlink('.shim.mjs').catch(() => {}));
}

const failed = results.filter(([s]) => s === 'FAIL');
for (const [s, name] of results) console.log(`${s} ${name}`);
console.log(`\n${results.length - failed.length}/${results.length} проверок пройдено`);
if (failed.length) process.exit(1);
