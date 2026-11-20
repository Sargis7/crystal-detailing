#!/usr/bin/env node
/**
 * test-api-telegram.js — тесты serverless-функции api/telegram.js.
 *
 * Функция принимает заявку от браузера и отправляет её в Bot API, держа
 * токен у себя. Главные риски, которые здесь проверяются:
 *
 *   1. Токен не попадает в ответ и в клиентский запрос — он читается только
 *      из окружения.
 *   2. Чат выбирается строго по branch, а не по полю chatId из тела: иначе
 *      открытую функцию можно превратить в спам-машину.
 *   3. Мусор на входе даёт понятный код ошибки, а не 500 с трейсом.
 *   4. Без токена функция честно отвечает not_configured и НЕ ходит в сеть.
 *
 * Сеть не используется: fetch подменяется. Настоящих запросов к Telegram
 * в тестах нет — в том числе чтобы случайно не отправить тестовую заявку
 * в боевую группу заказчика.
 *
 * Запуск: node tools/test-api-telegram.js
 * Код возврата: 0 — все проверки прошли, 1 — есть падения.
 */
'use strict';

import assert from 'node:assert/strict';
import { handler } from '../api/telegram.js';

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed += 1;
    failures.push({ name, message: e.message });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message.split('\n')[0]}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

/** Перехват fetch: фиксируем запросы, ответ подставляем. */
const realFetch = globalThis.fetch;
let calls = [];
let telegramReply = 'ok';

globalThis.fetch = async (url, options) => {
  calls.push({ url: String(url), options });
  if (telegramReply === 'network') {
    throw new TypeError('Failed to fetch');
  }
  if (telegramReply === 'reject') {
    return {
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: 'Bad Request: chat not found' }),
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: 42 } }),
  };
};

/** Перехват console.error: функция логирует детали, они не нужны в выводе. */
const realError = console.error;
console.error = () => {};

/** Тестовый токен. Настоящий в тестах не используется никогда. */
const TEST_TOKEN = '123456789:AAEtest_token_for_api_layer_check';

/**
 * Управление переменными окружения на время одного теста.
 *
 * @param {Object} values Переменные, которые нужно выставить.
 * @returns {() => void} Функция восстановления.
 */
function withEnv(values) {
  const saved = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

/**
 * Собирает запрос к функции.
 *
 * @param {Object} init Параметры запроса.
 * @returns {Request} Запрос.
 */
function makeRequest({ method = 'POST', body = null, origin = '', ip = '203.0.113.10' } = {}) {
  const headers = {};
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
  }
  if (origin) {
    headers.Origin = origin;
  }
  if (ip) {
    headers['x-forwarded-for'] = ip;
  }
  const payload = body === null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
  return new Request('https://crystal.test/api/telegram', { method, headers, body: payload });
}

/** Читает JSON из ответа. */
async function body(response) {
  return response.json();
}

/** Свежий адрес клиента, чтобы лимит частоты не влиял на соседние тесты. */
let ipCounter = 0;
function freshIp() {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. ГОТОВНОСТЬ И ЗАЩИТА КАНАЛА
// ─────────────────────────────────────────────────────────────────────────────

await section('1. Готовность и защита канала');

await check('без TELEGRAM_BOT_TOKEN → 500 not_configured, БЕЗ сетевого запроса', async () => {
  const restore = withEnv({ TELEGRAM_BOT_TOKEN: undefined });
  calls = [];
  const response = await handler(makeRequest({
    body: { branch: 'ru', text: 'тест' },
    ip: freshIp(),
  }));
  assert.equal(response.status, 500, `статус ${response.status}`);
  const data = await body(response);
  assert.equal(data.error, 'not_configured');
  assert.equal(calls.length, 0, `без токена ушло ${calls.length} запросов`);
  restore();
});

await check('GET → 405 method_not_allowed', async () => {
  const restore = withEnv({ TELEGRAM_BOT_TOKEN: TEST_TOKEN });
  const response = await handler(makeRequest({ method: 'GET', ip: freshIp() }));
  assert.equal(response.status, 405, `статус ${response.status}`);
  const data = await body(response);
  assert.equal(data.error, 'method_not_allowed');
  restore();
});

await check('чужой Origin при заданном ALLOWED_ORIGIN → 403', async () => {
  const restore = withEnv({
    TELEGRAM_BOT_TOKEN: TEST_TOKEN,
    ALLOWED_ORIGIN: 'https://sargis7.github.io',
  });
  calls = [];
  const response = await handler(makeRequest({
    body: { branch: 'ru', text: 'тест' },
    origin: 'https://evil.example',
    ip: freshIp(),
  }));
  assert.equal(response.status, 403, `статус ${response.status}`);
  const data = await body(response);
  assert.equal(data.error, 'origin_not_allowed');
  assert.equal(calls.length, 0, 'запрос с чужого домена не должен доходить до Bot API');
  restore();
});

await check('разрешённый Origin → запрос проходит', async () => {
  const restore = withEnv({
    TELEGRAM_BOT_TOKEN: TEST_TOKEN,
    ALLOWED_ORIGIN: 'https://sargis7.github.io',
  });
  const response = await handler(makeRequest({
    body: { branch: 'ru', text: 'тест' },
    origin: 'https://sargis7.github.io',
    ip: freshIp(),
  }));
  assert.equal(response.status, 200, `статус ${response.status}`);
  assert.equal(
    response.headers.get('Access-Control-Allow-Origin'),
    'https://sargis7.github.io',
    'в ответе нет CORS-заголовка с разрешённым доменом',
  );
  restore();
});

await check('OPTIONS → 204 с разрешением POST', async () => {
  const restore = withEnv({ TELEGRAM_BOT_TOKEN: TEST_TOKEN });
  const response = await handler(new Request('https://crystal.test/api/telegram', {
    method: 'OPTIONS',
    headers: { Origin: 'https://sargis7.github.io' },
  }));
  assert.equal(response.status, 204, `статус ${response.status}`);
  const methods = response.headers.get('Access-Control-Allow-Methods') || '';
  assert.ok(/POST/.test(methods), `preflight не разрешает POST: «${methods}»`);
  restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. МАРШРУТИЗАЦИЯ: ЧАТ ВЫБИРАЕТСЯ ТОЛЬКО ПО BRANCH
// ─────────────────────────────────────────────────────────────────────────────

await section('2. Маршрутизация: чат выбирается только по branch');

const CHAT_RU_ENV = '-1009999000001';
const CHAT_AM_ENV = '-1009999000002';

await check('заявка РФ уходит в TELEGRAM_CHAT_RU', async () => {
  const restore = withEnv({
    TELEGRAM_BOT_TOKEN: TEST_TOKEN,
    TELEGRAM_CHAT_RU: CHAT_RU_ENV,
    TELEGRAM_CHAT_AM: CHAT_AM_ENV,
  });
  calls = [];
  const response = await handler(makeRequest({
    body: { branch: 'ru', text: 'заявка из Липецка' },
    ip: freshIp(),
  }));
  assert.equal(response.status, 200, `статус ${response.status}`);
  assert.equal(calls.length, 1, `запросов: ${calls.length}`);
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(String(sent.chat_id), CHAT_RU_ENV, `ушло в chat_id=${sent.chat_id}`);
  restore();
});

await check('заявка Армении уходит в TELEGRAM_CHAT_AM', async () => {
  const restore = withEnv({
    TELEGRAM_BOT_TOKEN: TEST_TOKEN,
    TELEGRAM_CHAT_RU: CHAT_RU_ENV,
    TELEGRAM_CHAT_AM: CHAT_AM_ENV,
  });
  calls = [];
  await handler(makeRequest({
    body: { branch: 'am', text: 'заявка из Еревана' },
    ip: freshIp(),
  }));
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(String(sent.chat_id), CHAT_AM_ENV, `ушло в chat_id=${sent.chat_id}`);
  restore();
});

await check('КРИТИЧНО: chatId из тела запроса НЕ используется как адрес доставки', async () => {
  const restore = withEnv({
    TELEGRAM_BOT_TOKEN: TEST_TOKEN,
    TELEGRAM_CHAT_RU: CHAT_RU_ENV,
    TELEGRAM_CHAT_AM: CHAT_AM_ENV,
  });
  calls = [];
  // Злоумышленник подставляет чужой чат, надеясь использовать бота как
  // рассыльщик. Функция обязана проигнорировать поле.
  const response = await handler(makeRequest({
    body: { branch: 'ru', chatId: '-1007777777777', text: 'спам в чужой чат' },
    ip: freshIp(),
  }));
  assert.equal(response.status, 200, `статус ${response.status}`);
  const sent = JSON.parse(calls[0].options.body);
  assert.equal(String(sent.chat_id), CHAT_RU_ENV,
    `чат взят из тела запроса (${sent.chat_id}) — функция превращается в спам-машину`);
  assert.notEqual(String(sent.chat_id), '-1007777777777', 'подставленный chatId дошёл до Bot API');
  restore();
});

await check('неизвестный branch → 400, в Bot API ничего не уходит', async () => {
  const restore = withEnv({ TELEGRAM_BOT_TOKEN: TEST_TOKEN });
  calls = [];
  const response = await handler(makeRequest({
    body: { branch: 'kz', text: 'тест' },
    ip: freshIp(),
  }));
  assert.equal(response.status, 400, `статус ${response.status}`);
  const data = await body(response);
  assert.equal(data.error, 'bad_branch');
  assert.equal(calls.length, 0, 'при неизвестном регионе запрос уходить не должен');
  restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ВАЛИДАЦИЯ ВХОДА
// ─────────────────────────────────────────────────────────────────────────────

await section('3. Валидация входа');

await check('не-JSON тело → 400 bad_json', async () => {
  const restore = withEnv({ TELEGRAM_BOT_TOKEN: TEST_TOKEN });
  calls = [];
  const response = await handler(makeRequest({ body: 'не json', ip: freshIp() }));
  assert.equal(response.status, 400, `статус ${response.status}`);
  assert.equal((await body(response)).error, 'bad_json');
  assert.equal(calls.length, 0);
  restore();
});

await check('пустой текст → 400 empty_text', async () => {
  const restore = withEnv({ TELEGRAM_BOT_TOKEN: TEST_TOKEN });
  calls = [];
  const response = await handler(makeRequest({
    body: { branch: 'ru', text: '   ' },
    ip: freshIp(),
  }));
  assert.equal(response.status, 400, `статус ${response.status}`);
  assert.equal((await body(response)).error, 'empty_text');
  assert.equal(calls.length, 0);
  restore();
});

await check('текст длиннее 4096 символов → 400 text_too_long', async () => {
  const restore = withEnv({ TELEGRAM_BOT_TOKEN: TEST_TOKEN });
  calls = [];
  const response = await handler(makeRequest({
    body: { branch: 'ru', text: 'а'.repeat(4097) },
    ip: freshIp(),
  }));
  assert.equal(response.status, 400, `статус ${response.status}`);
  assert.equal((await body(response)).error, 'text_too_long');
  assert.equal(calls.length, 0, 'слишком длинный текст не должен доходить до Bot API');
  restore();
});

await check('тело больше 8 КБ → 413 body_too_large', async () => {
  const restore = withEnv({ TELEGRAM_BOT_TOKEN: TEST_TOKEN });
  calls = [];
  const response = await handler(makeRequest({
    body: { branch: 'ru', text: 'x'.repeat(9000) },
    ip: freshIp(),
  }));
  assert.equal(response.status, 413, `статус ${response.status}`);
  assert.equal((await body(response)).error, 'body_too_large');
  assert.equal(calls.length, 0);
  restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ОТКАЗ TELEGRAM И ГЛАВНАЯ ГАРАНТИЯ: ТОКЕНА В ОТВЕТЕ НЕТ
// ─────────────────────────────────────────────────────────────────────────────

await section('4. Отказ Telegram и утечка токена');

await check('Telegram отклонил запрос → 502 telegram_error, без деталей клиенту', async () => {
  const restore = withEnv({ TELEGRAM_BOT_TOKEN: TEST_TOKEN });
  telegramReply = 'reject';
  calls = [];
  const response = await handler(makeRequest({
    body: { branch: 'ru', text: 'тест' },
    ip: freshIp(),
  }));
  assert.equal(response.status, 502, `статус ${response.status}`);
  const raw = await response.text();
  assert.ok(/telegram_error/.test(raw), 'клиент не получил код telegram_error');
  assert.ok(!/chat not found/.test(raw), 'описание ошибки Telegram утекло в браузер');
  telegramReply = 'ok';
  restore();
});

await check('сетевой сбой → 502 network, исключения нет', async () => {
  const restore = withEnv({ TELEGRAM_BOT_TOKEN: TEST_TOKEN });
  telegramReply = 'network';
  const response = await handler(makeRequest({
    body: { branch: 'ru', text: 'тест' },
    ip: freshIp(),
  }));
  assert.equal(response.status, 502, `статус ${response.status}`);
  assert.equal((await body(response)).error, 'network');
  telegramReply = 'ok';
  restore();
});

await check('ГЛАВНОЕ: токен ни при каком ответе не попадает в тело и в запрос клиента', async () => {
  const restore = withEnv({ TELEGRAM_BOT_TOKEN: TEST_TOKEN });
  const scenarios = [
    { branch: 'ru', text: 'успешная заявка' },
    { branch: 'ru', text: '   ' },
    { branch: 'kz', text: 'мусор' },
  ];
  for (const scenario of scenarios) {
    calls = [];
    const response = await handler(makeRequest({ body: scenario, ip: freshIp() }));
    const raw = await response.text();
    assert.ok(!raw.includes(TEST_TOKEN), 'токен попал в тело ответа браузеру');
    for (const call of calls) {
      const requestBody = String(call.options && call.options.body);
      assert.ok(!requestBody.includes(TEST_TOKEN), 'токен попал в тело запроса, собранного функцией');
    }
  }
  restore();
});

await check('токен передаётся только в URL запроса к Bot API', async () => {
  const restore = withEnv({ TELEGRAM_BOT_TOKEN: TEST_TOKEN });
  calls = [];
  await handler(makeRequest({ body: { branch: 'ru', text: 'тест' }, ip: freshIp() }));
  assert.equal(calls.length, 1, `запросов: ${calls.length}`);
  assert.ok(calls[0].url.includes(TEST_TOKEN), 'запрос к Bot API ушёл без токена — он не сработает');
  assert.ok(/api\.telegram\.org\/bot/.test(calls[0].url), `адрес Bot API неверен: ${calls[0].url}`);
  restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ОГРАНИЧЕНИЕ ЧАСТОТЫ
// ─────────────────────────────────────────────────────────────────────────────

await section('5. Ограничение частоты');

await check('шестой запрос за минуту с одного адреса → 429', async () => {
  const restore = withEnv({ TELEGRAM_BOT_TOKEN: TEST_TOKEN });
  const ip = freshIp();
  let statuses = [];
  for (let i = 0; i < 6; i += 1) {
    calls = [];
    const response = await handler(makeRequest({
      body: { branch: 'ru', text: `заявка ${i}` },
      ip,
    }));
    statuses.push(response.status);
  }
  assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200], `первые пять: ${statuses.join(', ')}`);
  assert.equal(statuses[5], 429, `шестой запрос дал ${statuses[5]}, ожидался 429`);
  restore();
});

await check('лимит не задевает другой адрес', async () => {
  const restore = withEnv({ TELEGRAM_BOT_TOKEN: TEST_TOKEN });
  const first = freshIp();
  for (let i = 0; i < 6; i += 1) {
    await handler(makeRequest({ body: { branch: 'ru', text: `заявка ${i}` }, ip: first }));
  }
  const response = await handler(makeRequest({
    body: { branch: 'ru', text: 'другой посетитель' },
    ip: freshIp(),
  }));
  assert.equal(response.status, 200, `новый адрес получил ${response.status}`);
  restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. ИТОГИ
// ─────────────────────────────────────────────────────────────────────────────

console.error = realError;
globalThis.fetch = realFetch;

section('ИТОГИ');
console.log(`  Всего проверок: ${passed + failed}   PASS: ${passed}   FAIL: ${failed}`);
if (failures.length) {
  console.log('\n  УПАВШИЕ ПРОВЕРКИ:');
  failures.forEach((f) => {
    console.log(`    • ${f.name}`);
    console.log(`      ${f.message.split('\n')[0]}`);
  });
}
console.log('─'.repeat(64));

process.exitCode = failed > 0 ? 1 : 0;
