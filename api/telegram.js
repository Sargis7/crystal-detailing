/**
 * Serverless-функция отправки заявки в Telegram.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ЗАЧЕМ ЭТОТ ФАЙЛ
 * ──────────────────────────────────────────────────────────────────────────
 * Сайт статический, без сборки: js/config.js уезжает на хостинг как есть.
 * Если вписать туда токен бота, его получит любой посетитель, открыв
 * исходник страницы. Токен — это пароль от бота: с ним можно писать в
 * любой чат бота и менять его настройки.
 *
 * Поэтому токен живёт здесь, в переменной окружения хостинга. Браузер
 * отправляет заявку на этот адрес, функция добавляет chat_id и токен и
 * делает один запрос в api.telegram.org.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ (задаются в панели хостинга, НЕ в репозитории)
 * ──────────────────────────────────────────────────────────────────────────
 *   TELEGRAM_BOT_TOKEN  — токен от @BotFather (обязательно)
 *   TELEGRAM_CHAT_RU    — id чата для заявок из России
 *   TELEGRAM_CHAT_AM    — id чата для заявок из Армении
 *   ALLOWED_ORIGIN      — домен сайта для CORS, например
 *                         https://sargis7.github.io (необязательно)
 *
 * Если TELEGRAM_CHAT_RU/AM не заданы, используются значения по умолчанию
 * из DEFAULT_CHATS. Токен в значениях по умолчанию не хранится никогда.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ФОРМАТ ЗАПРОСА
 * ──────────────────────────────────────────────────────────────────────────
 *   POST /api/telegram
 *   { "branch": "am" | "ru", "chatId": "-100…", "text": "…" }
 *
 * Поле chatId приходит от клиента, но НЕ используется как адрес доставки:
 * целевой чат выбирается только по branch из белого списка. Иначе через
 * открытую функцию можно было бы рассылать сообщения в чужие чаты от
 * имени бота — это уже спам с вашего аккаунта.
 *
 * Файл написан под Vercel/Netlify-совместимый формат (Web API Request /
 * Response). Для Netlify Functions положите его как
 * netlify/functions/telegram.js и добавьте редирект /api/telegram.
 * Для Cloudflare Workers оберните: export default { fetch: handler }.
 *
 * @module api/telegram
 */

/** Значения чатов по умолчанию. Токена здесь нет и быть не может. */
const DEFAULT_CHATS = {
  ru: '-5584341581',
  am: '-5584341581',
};

/** Лимит Telegram на длину сообщения. Больше — 400 Bad Request. */
const MAX_MESSAGE_LENGTH = 4096;

/** Лимит на тело запроса: заявка — это несколько сотен байт. */
const MAX_BODY_BYTES = 8192;

/**
 * Простое ограничение частоты по адресу клиента.
 *
 * Адрес функции открыт, и без ограничения им можно забить группу
 * заявками — сам по себе токен от этого не пострадает, но менеджер
 * перестанет читать чат. Хранилище — Map в памяти процесса: на serverless
 * оно живёт недолго и не делится между инстансами, поэтому это защита от
 * случайного или грубого флуда, а не от целенаправленной атаки. Для
 * полноценной защиты нужен внешний счётчик (Upstash, KV) либо встроенный
 * rate limit платформы.
 */
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_PER_WINDOW = 5;
const rateBuckets = new Map();

/**
 * Проверяет, не превышен ли лимит для клиента.
 *
 * @param {string} key Идентификатор клиента.
 * @returns {boolean} true, если запрос можно обрабатывать.
 */
function allowRequest(key) {
  const now = Date.now();
  const hits = (rateBuckets.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX_PER_WINDOW) {
    rateBuckets.set(key, hits);
    return false;
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  // Чистим старые записи, иначе Map растёт вместе с числом клиентов.
  if (rateBuckets.size > 1000) {
    for (const [k, v] of rateBuckets) {
      if (!v.some((t) => now - t < RATE_WINDOW_MS)) {
        rateBuckets.delete(k);
      }
    }
  }
  return true;
}

/**
 * Определяет адрес клиента по заголовкам прокси хостинга.
 *
 * @param {Request} request Запрос.
 * @returns {string} Адрес или 'unknown'.
 */
function clientKey(request) {
  const forwarded = request.headers.get('x-forwarded-for') || '';
  const first = forwarded.split(',')[0].trim();
  return first || request.headers.get('x-real-ip') || 'unknown';
}

/**
 * Отдаёт JSON-ответ с нужными заголовками, включая CORS.
 *
 * @param {number} status HTTP-статус.
 * @param {Object} body Тело ответа.
 * @param {string} origin Проверенный Origin запроса.
 * @returns {Response} Ответ.
 */
function json(status, body, origin = '') {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    // Ответ не должен кэшироваться ни браузером, ни прокси: у каждой
    // заявки свой результат.
    'Cache-Control': 'no-store',
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Разрешает Origin. Пустой ALLOWED_ORIGIN означает «без CORS-заголовков»
 * (запросы с того же домена работают и так).
 *
 * @param {Request} request Запрос.
 * @returns {string|null} Разрешённый Origin либо null, если источник чужой.
 */
function resolveOrigin(request) {
  const allowed = (typeof process !== 'undefined' && process.env && process.env.ALLOWED_ORIGIN)
    ? String(process.env.ALLOWED_ORIGIN).split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  if (!allowed.length) {
    return '';
  }
  const origin = request.headers.get('origin') || '';
  return allowed.includes(origin) ? origin : null;
}

/**
 * Главный обработчик.
 *
 * @param {Request} request Входящий запрос.
 * @returns {Promise<Response>} Ответ.
 */
export async function handler(request) {
  const origin = resolveOrigin(request);
  if (origin === null) {
    return json(403, { ok: false, error: 'origin_not_allowed' });
  }

  // Preflight: браузер спрашивает разрешение до POST.
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      },
    });
  }

  if (request.method !== 'POST') {
    return json(405, { ok: false, error: 'method_not_allowed' }, origin);
  }

  const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    // Намеренно без деталей: сообщение уходит в браузер посетителя.
    console.error('[api/telegram] TELEGRAM_BOT_TOKEN не задан в окружении');
    return json(500, { ok: false, error: 'not_configured' }, origin);
  }

  // Тело читаем как текст, а не через request.json(): так проще отсечь
  // запросы с огромным телом до разбора.
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json(413, { ok: false, error: 'body_too_large' }, origin);
  }

  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch (error) {
    return json(400, { ok: false, error: 'bad_json' }, origin);
  }

  const branch = payload.branch === 'ru' ? 'ru' : (payload.branch === 'am' ? 'am' : null);
  if (!branch) {
    return json(400, { ok: false, error: 'bad_branch' }, origin);
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    return json(400, { ok: false, error: 'empty_text' }, origin);
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    return json(400, { ok: false, error: 'text_too_long' }, origin);
  }

  // Чат берём из окружения или из константы, но никогда из тела запроса.
  const chatId = branch === 'ru'
    ? (env.TELEGRAM_CHAT_RU || DEFAULT_CHATS.ru)
    : (env.TELEGRAM_CHAT_AM || DEFAULT_CHATS.am);

  if (!allowRequest(clientKey(request))) {
    return json(429, { ok: false, error: 'too_many_requests' }, origin);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        // Без parse_mode: имя и комментарий посетителя не должны уметь
        // внедрять разметку в сообщение менеджеру.
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });

    const result = await response.json().catch(() => null);

    if (!response.ok || !result || result.ok !== true) {
      // В лог — описание от Telegram, в браузер — нейтральный код.
      console.error('[api/telegram] Telegram отклонил запрос:', response.status, result && result.description);
      return json(502, { ok: false, error: 'telegram_error' }, origin);
    }

    return json(200, { ok: true, messageId: result.result && result.result.message_id }, origin);
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    console.error('[api/telegram] сеть недоступна:', aborted ? 'timeout' : (error && error.message));
    return json(502, { ok: false, error: aborted ? 'timeout' : 'network' }, origin);
  } finally {
    clearTimeout(timer);
  }
}

export default handler;
