#!/usr/bin/env node
/**
 * test-routing.js — тесты маршрутизации заявок и демо-режима.
 *
 * Покрывает требования PRD:
 *   R-32 — заявка РФ и Армении уходит в РАЗНЫЕ chat_id (ядро требования).
 *   R-33 — при незаполненном токене/chat_id: понятное предупреждение,
 *          НИКАКИХ сетевых запросов, отсутствие исключений.
 *   R-38 — состав сообщения менеджеру (регион, имя, телефон, модель,
 *          класс, цена, услуга, язык, время).
 *   R-31 — регион влияет на маршрут.
 *
 * Запуск: node tools/test-routing.js
 * Код возврата: 0 — все тесты прошли, 1 — есть падения.
 */
'use strict';

import assert from 'node:assert/strict';
import { CONFIG, isBranchReady, normalizeBranch } from '../js/config.js';
import { buildMessage, sendLead, getTransport } from '../js/telegram.js';

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

/** Перехват fetch: фиксируем запросы и подменяем ответ. */
const realFetch = globalThis.fetch;
let capturedRequests = [];
let fetchBehavior = 'ok';

globalThis.fetch = async (url, options) => {
  capturedRequests.push({ url: String(url), options });
  if (fetchBehavior === 'throw') {
    throw new TypeError('Failed to fetch');
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: 1 } }),
  };
};

/** Перехват console.info/warn, чтобы не засорять вывод. */
const realInfo = console.info;
const realWarn = console.warn;
console.info = () => {};
console.warn = () => {};

/** Базовый payload заявки. */
function payload(overrides = {}) {
  return {
    branch: 'ru',
    name: 'Иван Петров',
    phone: '+7 915 550-17-77',
    model: 'Toyota Camry',
    comment: '',
    consent: true,
    lang: 'ru',
    pageUrl: 'https://example.test/',
    iso8601: '2026-11-09T12:00:00.000Z',
    calc: null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. СОСТОЯНИЕ КОНФИГА (демо-режим)
// ─────────────────────────────────────────────────────────────────────────────

await section('1. Конфигурация по умолчанию (демо-режим)');

await check('chat_id РФ и Армении — РАЗНЫЕ поля конфига (R-32)', () => {
  const ru = CONFIG.telegram.chats.ru;
  const am = CONFIG.telegram.chats.am;
  assert.ok(ru, 'telegram.chats.ru отсутствует');
  assert.ok(am, 'telegram.chats.am отсутствует');
  assert.notEqual(ru, am, 'чаты РФ и Армении — один и тот же объект');
});

await check('telegram.chats содержит ровно два независимых филиала', () => {
  const ids = Object.keys(CONFIG.telegram.chats);
  assert.deepEqual(ids.sort(), ['am', 'ru']);
});

await check('isBranchReady(ru) и isBranchReady(am) раздельно отслеживают заполненность', () => {
  const ru = isBranchReady('ru');
  const am = isBranchReady('am');
  assert.equal(typeof ru.ok, 'boolean');
  assert.equal(typeof am.ok, 'boolean');
  assert.ok(Array.isArray(ru.missing), 'missing должен быть массивом');
  assert.ok(Array.isArray(am.missing), 'missing должен быть массивом');
  assert.ok(ru.missing.length > 0, 'в демо-режиме chat_id РФ не заполнен — missing не должен быть пуст');
});

await check('isBranchReady на несуществующем филиале не падает', () => {
  const r = isBranchReady('xx');
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.missing));
});

await check('плейсхолдеры не содержат выдуманных данных (R-63)', () => {
  // chat_id Армении в демо-режиме — заглушка, а не правдоподобный ID
  const amChat = CONFIG.telegram.chats.am.chatId;
  const ruChat = CONFIG.telegram.chats.ru.chatId;
  const looksFake = (v) => /^-?\d{6,}$/.test(String(v));
  assert.equal(looksFake(ruChat), false, `chat_id РФ = "${ruChat}" — похож на выдуманный реальный ID`);
  assert.equal(looksFake(amChat), false, `chat_id AM = "${amChat}" — похож на выдуманный реальный ID`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ДЕМО-РЕЖИМ: НЕТ СЕТИ, НЕТ ПАДЕНИЙ (R-33)
// ─────────────────────────────────────────────────────────────────────────────

await section('2. Демо-режим: graceful degradation (R-33)');

await check('sendLead при незаполненном конфиге → status not_configured, БЕЗ сетевого запроса', async () => {
  capturedRequests = [];
  const result = await sendLead(payload({ branch: 'ru' }));
  assert.equal(result.ok, false, 'ok должен быть false в демо-режиме');
  assert.equal(result.status, 'not_configured', `status=${result.status}`);
  assert.equal(capturedRequests.length, 0,
    `выполнено ${capturedRequests.length} сетевых запросов — при пустом токене их быть не должно`);
});

await check('sendLead для Армении в демо-режиме → not_configured, без сети', async () => {
  capturedRequests = [];
  const result = await sendLead(payload({ branch: 'am' }));
  assert.equal(result.status, 'not_configured');
  assert.equal(capturedRequests.length, 0, 'сетевой запрос не должен выполняться');
});

await check('sendLead возвращает целевой филиал даже при ошибке конфига', async () => {
  const ru = await sendLead(payload({ branch: 'ru' }));
  const am = await sendLead(payload({ branch: 'am' }));
  assert.equal(ru.targetBranch, 'ru', 'targetBranch РФ определён неверно');
  assert.equal(am.targetBranch, 'am', 'targetBranch Армении определён неверно');
});

await check('sendLead НИКОГДА не бросает исключение (мусор на входе)', async () => {
  const inputs = [null, undefined, {}, { branch: null }, { branch: 'xx' }, { branch: 123 }];
  for (const input of inputs) {
    const r = await sendLead(input);
    assert.ok(r && typeof r === 'object', `sendLead(${JSON.stringify(input)}) вернул ${r}`);
    assert.equal(typeof r.ok, 'boolean');
  }
});

await check('неизвестный branch безопасно приводится к основному филиалу', async () => {
  // Раньше запасным всегда был РФ. Теперь основной филиал задан в
  // CONFIG.primaryBranch (сайт делается для Еревана), и заявка без
  // выбранного филиала должна уходить именно туда. Проверяем не
  // конкретную букву, а согласованность с конфигом.
  const r = await sendLead(payload({ branch: 'unknown' }));
  assert.equal(
    r.targetBranch,
    CONFIG.primaryBranch,
    `неизвестный регион должен откатываться на CONFIG.primaryBranch (${CONFIG.primaryBranch})`,
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(CONFIG.branches, r.targetBranch),
    `targetBranch «${r.targetBranch}» отсутствует в CONFIG.branches`,
  );
});

await check('нормализация филиала: пустые и мусорные значения дают существующий филиал', () => {
  for (const bad of [null, undefined, '', '   ', 'xx', 123, {}, []]) {
    const id = normalizeBranch(bad);
    assert.ok(
      Object.prototype.hasOwnProperty.call(CONFIG.branches, id),
      `normalizeBranch(${JSON.stringify(bad)}) вернул неизвестный филиал «${id}»`,
    );
    assert.equal(id, CONFIG.primaryBranch, `мусор ${JSON.stringify(bad)} должен давать основной филиал`);
  }
  // Явно указанные существующие филиалы не подменяются основным.
  assert.equal(normalizeBranch('ru'), 'ru');
  assert.equal(normalizeBranch('am'), 'am');
  assert.equal(normalizeBranch('AM'), 'am', 'регистр не должен влиять');
});

await check('основной филиал объявлен первым в CONFIG.branches (порядок карточек)', () => {
  // ui.js строит карточки контактов в порядке ключей, поэтому основным
  // филиал должен быть и первым ключом — иначе на сайте сверху окажется
  // не тот город, для которого делается сайт.
  const first = Object.keys(CONFIG.branches)[0];
  assert.equal(
    first,
    CONFIG.primaryBranch,
    `первым в CONFIG.branches идёт «${first}», а primaryBranch — «${CONFIG.primaryBranch}»`,
  );
});

await check('sendLead не зависит от сети: сетевой сбой не приводит к исключению', async () => {
  fetchBehavior = 'throw';
  const r = await sendLead(payload({ branch: 'ru' }));
  assert.ok(r && typeof r === 'object', 'исключение при сбое сети');
  assert.equal(typeof r.ok, 'boolean');
  fetchBehavior = 'ok';
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. МАРШРУТИЗАЦИЯ В РАЗНЫЕ ЧАТЫ — ядро R-32
// ─────────────────────────────────────────────────────────────────────────────

await section('3. Маршрутизация РФ/Армения в РАЗНЫЕ chat_id (R-32)');

// Временно заполняем конфиг, чтобы проверить реальный путь отправки.
const CHAT_RU = '-1001111111111';
const CHAT_AM = '-1002222222222';
const originalToken = CONFIG.telegram.botToken;
const originalRu = CONFIG.telegram.chats.ru.chatId;
const originalAm = CONFIG.telegram.chats.am.chatId;

CONFIG.telegram.botToken = '123456789:AAEtest_token_for_routing_check';
CONFIG.telegram.chats.ru.chatId = CHAT_RU;
CONFIG.telegram.chats.am.chatId = CHAT_AM;

await check('заявка РФ уходит ТОЛЬКО в chat_id РФ', async () => {
  capturedRequests = [];
  const result = await sendLead(payload({ branch: 'ru' }));
  assert.equal(result.ok, true, `ok=${result.ok}, status=${result.status}`);
  assert.equal(result.targetChatId, CHAT_RU, `targetChatId=${result.targetChatId}`);
  assert.equal(capturedRequests.length, 1, `запросов: ${capturedRequests.length}`);
  const body = JSON.parse(capturedRequests[0].options.body);
  assert.equal(String(body.chat_id), CHAT_RU, `в Telegram ушёл chat_id=${body.chat_id}`);
});

await check('заявка Армении уходит ТОЛЬКО в chat_id Армении', async () => {
  capturedRequests = [];
  const result = await sendLead(payload({ branch: 'am', phone: '+374 10 123456' }));
  assert.equal(result.ok, true, `ok=${result.ok}, status=${result.status}`);
  assert.equal(result.targetChatId, CHAT_AM, `targetChatId=${result.targetChatId}`);
  assert.equal(capturedRequests.length, 1);
  const body = JSON.parse(capturedRequests[0].options.body);
  assert.equal(String(body.chat_id), CHAT_AM, `в Telegram ушёл chat_id=${body.chat_id}`);
});

await check('КРИТИЧНО: chat_id РФ и Армении различаются при реальной отправке', async () => {
  capturedRequests = [];
  await sendLead(payload({ branch: 'ru' }));
  const ruChatId = JSON.parse(capturedRequests[0].options.body).chat_id;
  capturedRequests = [];
  await sendLead(payload({ branch: 'am' }));
  const amChatId = JSON.parse(capturedRequests[0].options.body).chat_id;
  assert.notEqual(String(ruChatId), String(amChatId),
    `ОБА филиала отправляют в ОДИН чат (${ruChatId}) — лиды РФ и Армении смешаются`);
});

await check('текст заявки не утекает в «чужой» чат: маршрут выбирается строго по branch', async () => {
  capturedRequests = [];
  await sendLead(payload({ branch: 'am' }));
  const body = JSON.parse(capturedRequests[0].options.body);
  assert.ok(String(body.chat_id) === CHAT_AM, 'заявка Армении ушла не в армянский чат');
  assert.ok(/Регион: Армения/.test(body.text), 'в тексте неверно указан регион');
});

// Возвращаем конфиг в исходное состояние.
CONFIG.telegram.botToken = originalToken;
CONFIG.telegram.chats.ru.chatId = originalRu;
CONFIG.telegram.chats.am.chatId = originalAm;

// ─────────────────────────────────────────────────────────────────────────────
// 4. СОСТАВ СООБЩЕНИЯ МЕНЕДЖЕРУ (R-38)
// ─────────────────────────────────────────────────────────────────────────────

await section('4. Состав сообщения менеджеру (R-38)');

await check('сообщение содержит все обязательные поля', () => {
  const text = buildMessage(payload({
    branch: 'am',
    name: 'Арам',
    phone: '+374 10 123456',
    model: 'BMW X5',
    lang: 'hy',
    calc: {
      vin: 'WBAFR9C50BC270821',
      make: 'BMW',
      model: 'X5',
      year: 2011,
      carClass: 4,
      serviceId: 'complex-wash',
      priceLow: 11900,
      priceHigh: 15800,
    },
  }));

  const required = [
    ['регион', /Регион:\s*Армения/],
    ['имя', /Имя:\s*Арам/],
    ['телефон', /Телефон:\s*\+374/],
    ['модель', /Модель:\s*BMW X5/],
    ['класс авто', /Класс авто:\s*4/],
    ['ориентир цены', /Ориентир цены/],
    ['услуга', /Услуга:/],
    ['язык сайта', /Язык сайта:\s*армянский/],
    ['время', /Время \(UTC\)/],
    ['VIN', /VIN:\s*WBAFR9C50BC270821/],
  ];

  for (const [label, re] of required) {
    assert.ok(re.test(text), `в сообщении отсутствует «${label}» (${re})`);
  }
});

await check('сообщение отправляется БЕЗ parse_mode (защита от инъекции разметки)', async () => {
  CONFIG.telegram.botToken = '123456789:AAEtest_token_for_routing_check';
  CONFIG.telegram.chats.ru.chatId = CHAT_RU;
  capturedRequests = [];
  await sendLead(payload({ name: '<b>Взлом</b>', comment: '<script>alert(1)</script>' }));
  const body = JSON.parse(capturedRequests[0].options.body);
  assert.equal(body.parse_mode, undefined, 'parse_mode не должен передаваться');
  CONFIG.telegram.botToken = originalToken;
  CONFIG.telegram.chats.ru.chatId = originalRu;
});

await check('buildMessage не падает на пустом payload', () => {
  const text = buildMessage({});
  assert.ok(typeof text === 'string' && text.length > 0, 'пустое сообщение');
});

await check('buildMessage устойчив к null/undefined-полям', () => {
  const text = buildMessage({
    branch: null, name: null, phone: undefined, model: null,
    lang: null, consent: false, calc: null,
  });
  assert.ok(text.length > 0);
  assert.ok(!/undefined/.test(text), 'в сообщение просочилось undefined');
  assert.ok(!/null/.test(text), 'в сообщение просочился null');
});

await check('сообщение без расчёта VIN не содержит пустого блока VIN', () => {
  const text = buildMessage(payload({ calc: null }));
  assert.ok(!/VIN:/.test(text), 'блок VIN присутствует без расчёта');
  assert.ok(/Услуга:\s*—/.test(text), 'отсутствует прочерк вместо услуги');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ТРАНСПОРТ
// ─────────────────────────────────────────────────────────────────────────────

await section('5. Выбор транспорта');

await check('getTransport возвращает транспорт с методом send', () => {
  const t = getTransport();
  assert.ok(t, 'getTransport вернул пустое значение');
  assert.equal(typeof t.send, 'function', 'у транспорта нет метода send');
  assert.ok(['direct', 'proxy'].includes(t.name), `неизвестный транспорт: ${t.name}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. ИТОГИ
// ─────────────────────────────────────────────────────────────────────────────

console.info = realInfo;
console.warn = realWarn;
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
