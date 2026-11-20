/**
 * HTTP-сервер сайта Crystal: статика + прокси для заявок в Telegram.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ЗАЧЕМ ОН НУЖЕН
 * ──────────────────────────────────────────────────────────────────────────
 * Railway собирает проект как «staticfile» и раздаёт файлы через Caddy.
 * Такая сборка не умеет исполнять javascript: запрос POST /api/telegram
 * получает 404 от файлового сервера, а не попадает в api/telegram.js.
 * Этот сервер закрывает ровно эту дыру — он отдаёт те же файлы, что и
 * раньше, но путь /api/telegram обрабатывает сам.
 *
 * Сам обработчик живёт в api/telegram.js и написан в формате Web API
 * (Request → Response). Он же годится для Vercel и Netlify; здесь мы
 * только конвертируем входящий http.IncomingMessage в Request и обратно.
 * Благодаря этому бизнес-логика остаётся в одном месте и
 * tools/test-api-telegram.js по-прежнему проверяет именно её.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ПОЧЕМУ НЕ express
 * ──────────────────────────────────────────────────────────────────────────
 * Задач всего две — отдать файл и вызвать одну функцию. express потянул бы
 * дерево зависимостей и слой абстракции, который здесь нечего абстрагировать.
 * Модуль http входит в Node, а значит `npm ci` на Railway остаётся пустым
 * и сборка не может сломаться из-за несовместимости пакетов.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ
 * ──────────────────────────────────────────────────────────────────────────
 *   PORT               — порт, который даёт хостинг (Railway подставляет сам)
 *   TELEGRAM_BOT_TOKEN — обязательна для отправки (см. api/telegram.js)
 *   TELEGRAM_CHAT_RU   — необязательна
 *   TELEGRAM_CHAT_AM   — необязательна
 *   ALLOWED_ORIGIN     — не нужна: сайт и прокси на одном origin
 *
 *   node server.mjs   или   npm start
 *
 * @module server
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handler as telegramHandler } from './api/telegram.js';

/** Корень сайта: раздача идёт от него, а не от cwd — на хостинге cwd бывает иным. */
const ROOT = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;

/** Путь, который обслуживает прокси. Всё остальное — статика. */
const API_PATH = '/api/telegram';

/**
 * Что нельзя отдавать даже при прямом запросе.
 *
 * Список закрывает не только служебные каталоги, но и файлы, из которых
 * складывается «как это сделано»: исходники сборки ассетов и тесты. Они
 * не секретны, но и пользы посетителю не несут, а .git на живом сервере
 * означает, что можно скачать всю историю проекта.
 */
const DENY_PREFIXES = [
  '.git/',
  '.github/',
  'node_modules/',
  'tools/',
  'brand/',
  'api/',
  '_site/',
  '.workbuddy-ai/',
];

const DENY_FILES = new Set([
  '.gitignore',
  '.env',
  '.env.example',
  'package.json',
  'package-lock.json',
  'server.mjs',
  'netlify.toml',
  'vercel.json',
]);

/** Расширение → MIME. Полный список mimetypes не нужен: файлов ровно несколько типов. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf',
};

/**
 * Заголовки безопасности статики.
 *
 * nosniff обязателен: без него старые браузеры угадывают тип файла и
 * могут исполнить картинку как скрипт. Referrer-Policy не даёт утекать
 * адресу страницы при переходах на внешние сайты. frame-ancestors в CSP
 * закрывает кликджекинг: сайт с формой заявки не должен вставляться
 * в чужой iframe.
 *
 * CSP намеренно разрешает inline-скрипты: в index.html есть синхронный
 * скрипт установки языка до первой отрисовки, и он обязан быть инлайновым.
 */
const STATIC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data:",
    "media-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; '),
};

/**
 * Превращает входящий Node-запрос в стандартный Request.
 *
 * Тело читаем с ограничением: заявка — это несколько сотен байт, а
 * принять гигабайт от анонимного клиента и потом отбросить — это уже
 * способ вывести сервер из строя. Лимит с запасом к тому, что проверяет
 * сам обработчик (8 КБ).
 *
 * @param {http.IncomingMessage} req Входящий запрос Node.
 * @returns {Promise<Request>} Запрос в формате Web API.
 */
async function toFetchRequest(req) {
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url || '/', `https://${host}`);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  const method = (req.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? await readLimitedBody(req, 16 * 1024) : undefined;

  return new Request(url, { method, headers, body });
}

/**
 * Читает тело запроса с ограничением по размеру.
 *
 * ⚠️ При превышении лимита мы НЕ рвём соединение. Соблазн велик:
 * req.destroy() освобождает память немедленно. Но клиент в этом случае
 * видит не ответ «слишком много данных», а сетевой обрыв, и в консоли
 * браузера это «Failed to fetch» — то есть посетитель с нестандартно
 * большим комментарием не поймёт, что произошло. Поэтому лишние байты
 * молча отбрасываются, поток дочитывается до конца, а решение принимает
 * вызывающий: он видит err.code и отвечает 413 по-человечески.
 *
 * @param {http.IncomingMessage} req Входящий запрос.
 * @param {number} limit Максимум байт.
 * @returns {Promise<Buffer>} Тело (усечённое, если лимит превышен).
 */
function readLimitedBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflowed = false;
    req.on('data', (chunk) => {
      if (overflowed) return; // остаток дочитываем впустую
      size += chunk.length;
      if (size > limit) {
        overflowed = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflowed) {
        reject(Object.assign(new Error('body_too_large'), { code: 'BODY_TOO_LARGE' }));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

/**
 * Отправляет Response обратно в Node-ответ.
 *
 * @param {Response} response Ответ обработчика.
 * @param {http.ServerResponse} res Ответ Node.
 * @returns {Promise<void>}
 */
async function sendFetchResponse(response, res) {
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  res.end(Buffer.from(await response.arrayBuffer()));
}

/**
 * Проверяет, можно ли отдавать этот путь как статику.
 *
 * Проверок три и все обязательные: выход за корень (`../`), скрытые
 * файлы и служебные каталоги.
 *
 * @param {string} relativePath Путь относительно корня, через прямой слэш.
 * @returns {boolean} true, если файл можно отдать.
 */
function isPublicPath(relativePath) {
  if (!relativePath) return true;
  if (relativePath.includes('\0')) return false;
  const segments = relativePath.split('/');
  if (segments.some((s) => s === '..' || s === '.' || s === '')) return false;
  if (segments.some((s) => s.startsWith('.'))) return false;
  for (const prefix of DENY_PREFIXES) {
    if (relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix)) return false;
  }
  if (DENY_FILES.has(relativePath)) return false;
  return true;
}

/**
 * Раздаёт статический файл: находит его, отдаёт с ETag и поддержкой 304.
 *
 * ETag считается по mtime и размеру — читать файл целиком ради хэша
 * незачем, а браузер при повторном заходе получит 304 вместо мегабайта
 * картинок.
 *
 * @param {string} urlPath Путь из URL.
 * @param {http.IncomingMessage} req Запрос (нужен If-None-Match).
 * @param {http.ServerResponse} res Ответ.
 * @returns {Promise<boolean>} false, если файла нет — обработает 404.
 */
async function serveStatic(urlPath, req, res) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (error) {
    // Битый процент-код в URL — это не наш файл.
    return false;
  }

  // Чистим ведущий слэш и приводим разделитель к POSIX: с Windows-путями
  // path.sep иначе протащит обратную косую черту в проверку.
  let relative = decoded.replace(/^\/+/, '').replace(/\\/g, '/');
  if (relative.endsWith('/') || relative === '') {
    relative += 'index.html';
  }
  if (!isPublicPath(relative)) {
    return false;
  }

  const full = path.resolve(ROOT, relative);
  // Вторая линия защиты: normalize уже мог выйти за корень.
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    return false;
  }

  let stat;
  try {
    stat = await fsp.stat(full);
  } catch (error) {
    return false;
  }

  if (stat.isDirectory()) {
    return serveStatic(`${decoded.replace(/\/+$/, '')}/index.html`, req, res);
  }

  const ext = path.extname(full).toLowerCase();
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;

  // index.html не кэшируем: в нём лежит разметка, которая меняется с
  // каждым релизом, и залипший на сутки HTML ломает обновление сайта.
  // Остальное стабильно и кэшируется надолго.
  const cacheControl = ext === '.html'
    ? 'public, max-age=0, must-revalidate'
    : 'public, max-age=86400';

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ...STATIC_HEADERS, ETag: etag, 'Cache-Control': cacheControl });
    res.end();
    return true;
  }

  res.writeHead(200, {
    ...STATIC_HEADERS,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': cacheControl,
  });

  if ((req.method || 'GET').toUpperCase() === 'HEAD') {
    res.end();
    return true;
  }

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(full);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res, { end: true });
  });
  return true;
}

/**
 * Отдаёт простую страницу 404.
 *
 * @param {http.ServerResponse} res Ответ.
 */
function notFound(res) {
  const body = Buffer.from(
    '<!doctype html><meta charset="utf-8"><title>404</title>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="margin:0;display:grid;place-items:center;min-height:100vh;' +
    'background:#0A0A0C;color:#F5F5F7;font:16px/1.5 system-ui,sans-serif">' +
    '<div style="text-align:center"><p style="font-size:64px;margin:0;color:#0074BA">404</p>' +
    '<p>Страница не найдена</p><p><a href="/" style="color:#0074BA">На главную</a></p></div>',
    'utf8'
  );
  res.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...STATIC_HEADERS,
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  try {
    if (urlPath === API_PATH) {
      let fetchRequest;
      try {
        fetchRequest = await toFetchRequest(req);
      } catch (error) {
        if (error && error.code === 'BODY_TOO_LARGE') {
          res.writeHead(413, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ ok: false, error: 'body_too_large' }));
          return;
        }
        throw error;
      }
      const fetchResponse = await telegramHandler(fetchRequest);
      await sendFetchResponse(fetchResponse, res);
      return;
    }

    // Голый /api/... кроме нашего пути — честный 404, а не index.html:
    // иначе опечатка в адресе выглядела бы как рабочий эндпоинт.
    if (urlPath.startsWith('/api/')) {
      res.writeHead(404, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: false, error: 'not_found' }));
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
      res.end('Method Not Allowed');
      return;
    }

    const served = await serveStatic(urlPath, req, res);
    if (!served) {
      notFound(res);
    }
  } catch (error) {
    // Сюда попадают только сбои самого сервера: обработчик заявки ловит
    // свои ошибки сам и всегда возвращает Response.
    console.error('[server] непойманная ошибка:', error);
    if (!res.headersSent) {
      res.writeHead(500, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ ok: false, error: 'internal' }));
    } else {
      res.end();
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  // Строка в лог при старте: половина проблем с отправкой — это забытая
  // переменная окружения, и увидеть её нужно сразу, а не при первой заявке.
  const tokenState = process.env.TELEGRAM_BOT_TOKEN ? 'задан' : 'НЕ ЗАДАН';
  console.log(`[server] Crystal слушает http://0.0.0.0:${PORT}`);
  console.log(`[server] статика из ${ROOT}`);
  console.log(`[server] TELEGRAM_BOT_TOKEN: ${tokenState}`);
});

/** Аккуратное завершение: Railway при деплое посылает SIGTERM. */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[server] получен ${signal}, останавливаюсь`);
    server.close(() => process.exit(0));
    // Если соединения не закрылись за 5 секунд — выходим принудительно.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

export { server };

