#!/usr/bin/env node
/**
 * test-vin.js — тесты VIN-калькулятора crystal-detailing.
 *
 * Проверяет требования PRD R-20…R-28 и контрольную таблицу цен
 * из комментариев js/config.js (блок «Контрольная таблица»).
 *
 * Покрытие:
 *   1. validateVin — пустой ввод, короткая длина, символы I/O/Q, валидный VIN.
 *   2. decodeYear — определение года по 10-му символу.
 *   3. decodeWmi — распознавание марки/региона на реальных VIN разных марок.
 *   4. Неизвестный VIN — отсутствие падения, грациозная деградация.
 *   5. resolveClass — класс авто по модели.
 *   6. quote/quoteAll — расчёт цены, контрольная таблица, фиксированные цены.
 *   7. formatRange — диапазон и округление.
 *   8. Идемпотентность и отсутствие исключений.
 *
 * Запуск: node tools/test-vin.js
 * Код возврата: 0 — все тесты прошли, 1 — есть падения.
 */
'use strict';

import assert from 'node:assert/strict';
import { validateVin, decodeYear, decodeWmi, decodeVinLocal } from '../js/vin/decoder.js';
import { resolveClass, quote, quoteAll, formatRange } from '../js/vin/pricing.js';
import { createLocalProvider } from '../js/vin/provider.js';

let passed = 0;
let failed = 0;
const failures = [];

/**
 * Мини-раннер: выполняет проверку и фиксирует результат.
 * Реализован вручную, чтобы не зависеть от версии node:test.
 *
 * @param {string} name Название теста.
 * @param {Function} fn Тело теста (может быть async).
 */
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

/** Группировка вывода по секциям. */
function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. ВАЛИДАЦИЯ VIN (R-24)
// ─────────────────────────────────────────────────────────────────────────────

await section('1. Валидация VIN (R-24)');

await check('пустой ввод → errorCode "required"', () => {
  const r = validateVin('');
  assert.equal(r.valid, false);
  assert.equal(r.errorCode, 'required');
});

await check('null / undefined → "required", без исключения', () => {
  assert.equal(validateVin(null).errorCode, 'required');
  assert.equal(validateVin(undefined).errorCode, 'required');
});

await check('короткий VIN "123" → errorCode "length"', () => {
  const r = validateVin('123');
  assert.equal(r.valid, false);
  assert.equal(r.errorCode, 'length');
});

await check('VIN из 16 символов → "length"', () => {
  const r = validateVin('1HGCM82633A00435');
  assert.equal(r.errorCode, 'length');
});

await check('VIN из 18 символов → "length"', () => {
  const r = validateVin('1HGCM82633A0043521');
  assert.equal(r.errorCode, 'length');
});

await check('символ I внутри VIN → "chars", I в invalidChars', () => {
  const r = validateVin('1HGCM82633A00I123');
  assert.equal(r.valid, false);
  assert.equal(r.errorCode, 'chars');
  assert.ok(r.invalidChars.includes('I'), `invalidChars=${JSON.stringify(r.invalidChars)}`);
});

await check('символ O внутри VIN → "chars"', () => {
  const r = validateVin('1HGCM82633A00O123');
  assert.equal(r.errorCode, 'chars');
  assert.ok(r.invalidChars.includes('O'));
});

await check('символ Q внутри VIN → "chars"', () => {
  const r = validateVin('1HGCM82633A00Q123');
  assert.equal(r.errorCode, 'chars');
  assert.ok(r.invalidChars.includes('Q'));
});

await check('нижний регистр и дефисы нормализуются', () => {
  const r = validateVin('1hgcm8-2633a004352');
  assert.equal(r.normalized, '1HGCM82633A004352');
});

await check('валидный VIN Honda Accord → valid=true', () => {
  const r = validateVin('1HGCM82633A004352');
  assert.equal(r.valid, true, `errorCode=${r.errorCode}, checksum=${r.checksum}`);
  assert.equal(r.errorCode, null);
});

await check('валидные VIN разных марок проходят валидацию', () => {
  const vins = [
    'WVWZZZ1JZXW000001',  // Volkswagen, EU — контрольная сумма неприменима
    'WBAFR9C50BC270821',  // BMW, EU
    'JHMCM56557C404453',  // Honda, JDM
    'KMHJN81BP7U123456',  // Hyundai, KR
    'XTA21150053912345',  // Lada, RU
  ];
  for (const vin of vins) {
    const r = validateVin(vin);
    assert.equal(r.valid, true, `${vin} → ${r.errorCode}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. РАСШИФРОВКА: МАРКА, ГОД, РЕГИОН (R-21)
// ─────────────────────────────────────────────────────────────────────────────

await section('2. Расшифровка VIN: WMI, год, регион (R-21)');

await check('decodeWmi: Honda Accord 1HG… → Honda, регион US', () => {
  const w = decodeWmi('1HGCM82633A004352');
  assert.ok(w, 'decodeWmi вернул null');
  assert.equal(w.make, 'Honda');
  assert.equal(w.region, 'US');
});

await check('decodeWmi: BMW WBA… → BMW, регион DE', () => {
  const w = decodeWmi('WBAFR9C50BC270821');
  assert.ok(w, 'decodeWmi вернул null');
  assert.equal(w.make, 'BMW');
  assert.equal(w.region, 'DE');
});

await check('decodeWmi: Volkswagen WVW… → Volkswagen, DE', () => {
  const w = decodeWmi('WVWZZZ1JZXW000001');
  assert.ok(w, 'decodeWmi вернул null');
  assert.equal(w.make, 'Volkswagen');
  assert.equal(w.region, 'DE');
});

await check('decodeWmi: Hyundai KMH… → Hyundai, KR', () => {
  const w = decodeWmi('KMHJN81BP7U123456');
  assert.ok(w, 'decodeWmi вернул null');
  assert.equal(w.make, 'Hyundai');
});

await check('decodeWmi: слишком короткий VIN → null, без исключения', () => {
  assert.equal(decodeWmi('AB'), null);
  assert.equal(decodeWmi(''), null);
  assert.equal(decodeWmi(null), null);
});

await check('decodeYear: 10-й символ определяет год', () => {
  // 10-й символ VIN = индекс 9. Проверяем на реальных VIN.
  // 1HGCM8263AA004352 → индекс 9 = 'A' → 2010
  assert.equal(decodeYear('1HGCM8263AA004352'), 2010, 'A → 2010');
  // WBAFR9C50BC270821 → индекс 9 = 'B' → 2011
  assert.equal(decodeYear('WBAFR9C50BC270821'), 2011, 'B → 2011');
});

await check('decodeYear: нераспознанный символ → null', () => {
  // Все цифры 1–9 распознаются как годы, поэтому берём недопустимый
  // для таблицы годов 10-й символ. Проверяем на VIN с 'U' (в таблицах отсутствует).
  assert.equal(decodeYear('1HGCM8263UA004352'), null, 'U отсутствует в таблицах годов');
});

await check('decodeVinLocal: Honda Accord → расшифровка не пустая', async () => {
  // VIN с корректной контрольной суммой: 10-й символ 'A' → 2010 год.
  // (Прежний вариант …A00… не проходил проверку контрольной суммы и валидно
  //  отвергался декодером — ошибка была в тесте, а не в коде.)
  const info = await decodeVinLocal('1HGCM8263A3000352');
  assert.equal(info.source, 'local');
  assert.equal(info.make, 'Honda', `make=${info.make}`);
  assert.equal(info.year, 2010, `year=${info.year}`);
  assert.equal(info.model, 'Accord', `model=${info.model}`);
});

await check('decodeVinLocal отдаёт carClass=null, а не 0 (класс считает pricing)', async () => {
  // Контракт: расшифровка VIN не занимается ценообразованием. Значение 0
  // означало бы «вне диапазона 1–5» и ломало бы UI — ожидаем null.
  const info = await decodeVinLocal('1HGCM8263A3000352');
  assert.equal(info.carClass, null, `carClass=${info.carClass}`);
});

await check('decodeVinLocal НИКОГДА не бросает исключение на мусоре', async () => {
  const junk = ['', null, undefined, '!!!!', 'николай', '123', 'ZZZZZZZZZZZZZZZZZ', '   '];
  for (const raw of junk) {
    const info = await decodeVinLocal(raw);
    assert.ok(info && typeof info === 'object', `decodeVinLocal(${JSON.stringify(raw)}) вернул ${info}`);
  }
});

await check('неизвестный WMI → make=null, errorCode заполнен, класс валиден', async () => {
  // 'ZZZ' отсутствует в WMI-таблице — декодер обязан деградировать, а не падать.
  // ВАЖНО: 'CM826' есть в MODEL_PREFIXES (Accord), поэтому модель распознаётся
  // даже при неизвестной марке.
  //
  // Проверяем через provider.decode() — это ПУБЛИЧНЫЙ контракт: именно он
  // достраивает carClass через resolveClass. decodeVinLocal() класс не считает
  // (ценообразование — не его задача) и отдаёт carClass=null.
  const provider = createLocalProvider();
  const info = await provider.decode('ZZZCM8263A3000352');
  assert.equal(info.make, null, `make=${info.make} (ожидался null)`);
  assert.ok(info.carClass >= 1 && info.carClass <= 5,
    `carClass=${info.carClass} — вне диапазона 1–5`);
});

await check('неизвестный WMI без распознанной модели → classGuessed=true, errorCode заполнен', async () => {
  // 'ZZZZZ' нет ни в WMI, ни в MODEL_PREFIXES — полная нераспознанность.
  const provider = createLocalProvider();
  const info = await provider.decode('ZZZZZZZZZZZZZZZZZ');
  assert.equal(info.make, null);
  assert.equal(info.model, null, `model=${info.model} — не должен распознаваться`);
  assert.equal(info.classGuessed, true, 'classGuessed должен быть true');
  assert.ok(info.errorCode, 'errorCode должен быть заполнен для нераспознанного VIN');
  assert.equal(info.carClass, 2, 'при нераспознанном VIN — defaultClass=2');
});

await section('3. Класс автомобиля 1–5 (R-22, R-27)');

await check('resolveClass: нераспознанная модель → defaultClass=2, guessed=true', () => {
  const r = resolveClass({ model: null, make: null, makeEn: null });
  assert.equal(r.carClass, 2, `carClass=${r.carClass}`);
  assert.equal(r.guessed, true);
});

await check('resolveClass: null на входе → не падает, возвращает класс по умолчанию', () => {
  const r = resolveClass(null);
  assert.equal(r.carClass, 2);
  assert.equal(r.guessed, true);
});

await check('resolveClass: явно заданный класс имеет приоритет', () => {
  const r = resolveClass({ carClass: 5, classGuessed: false, model: 'Corolla' });
  assert.equal(r.carClass, 5, 'явный класс должен победить эвристику по модели');
  assert.equal(r.guessed, false);
});

await check('resolveClass: класс всегда в диапазоне 1–5', () => {
  const inputs = [
    {}, null, { model: 'Accord' }, { model: 'X7' }, { model: 'Rio' },
    { model: 'несуществующая модель' }, { carClass: 99 }, { carClass: -1 }, { carClass: 0 },
  ];
  for (const input of inputs) {
    const r = resolveClass(input);
    assert.ok(r.carClass >= 1 && r.carClass <= 5,
      `resolveClass(${JSON.stringify(input)}) → carClass=${r.carClass} вне диапазона 1–5`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. РАСЧЁТ ЦЕНЫ (R-23, R-25) — контрольная таблица из config.js
// ─────────────────────────────────────────────────────────────────────────────

await section('4. Расчёт цены: контрольная таблица заказчика (R-23)');

// Эталон из комментария CONFIG.pricing.services в js/config.js:
//   подкапотное:    кл.1 3900 · кл.2 5200 · кл.3 6000 · кл.4 8100  · кл.5 11000
//
// Комплекс-мойка («детейлинг мойка») удалена из прайса по просьбе
// заказчика (ноябрь 2026) — её эталонные строки убраны: тест на услугу,
// которой нет в CONFIG, падал бы по правильной причине, но ничего не
// проверял бы в самом расчёте.
const REFERENCE = {
  'engine-bay': { 1: 3900, 2: 5200, 3: 6000, 4: 8100, 5: 11000 },
};

for (const [serviceId, expected] of Object.entries(REFERENCE)) {
  for (const [cls, price] of Object.entries(expected)) {
    await check(`quote('${serviceId}', класс ${cls}) = ${price} ₽`, () => {
      const q = quote(serviceId, Number(cls));
      assert.ok(q, `quote вернул null для ${serviceId}/${cls}`);
      assert.equal(q.total, price, `ожидалось ${price}, получено ${q.total}`);
    });
  }
}

await check('комплекс-мойка удалена из прайса → quote возвращает null', () => {
  assert.equal(quote('complex-wash', 2), null, 'услуга вернулась в CONFIG.pricing.services');
});

await check('опорная точка прайса: подкапотное класс 3 = 6 000 ₽ (R-03)', () => {
  assert.equal(quote('engine-bay', 3).total, 6000);
});

await check('антихром — фиксированная цена «от 20 000 ₽», множитель класса НЕ применяется', () => {
  for (const cls of [1, 2, 3, 4, 5]) {
    const q = quote('antichrome', cls);
    assert.equal(q.total, 20000, `класс ${cls}: ожидалось 20000, получено ${q.total}`);
    assert.equal(q.fromFixed, true, 'fromFixed должен быть true для антихрома');
    assert.equal(q.multiplier, 1, 'множитель не должен применяться');
  }
});

await check('несуществующая услуга → null, без исключения', () => {
  assert.equal(quote('no-such-service', 2), null);
});

await check('некорректный класс в quote → откат на defaultClass, не NaN', () => {
  for (const bad of [0, 6, -1, null, undefined, 'x', 2.5, NaN]) {
    const q = quote('engine-bay', bad);
    assert.ok(q, `quote вернул null для класса ${JSON.stringify(bad)}`);
    assert.ok(Number.isFinite(q.total), `total не число для класса ${JSON.stringify(bad)}: ${q.total}`);
    assert.ok(q.carClass >= 1 && q.carClass <= 5, `carClass=${q.carClass}`);
  }
});

await check('диапазон = [total × 0.9 … total × 1.2], округление до сотен (R-25)', () => {
  const q = quote('engine-bay', 2); // total = 5200
  assert.equal(q.low, 4700, `low=${q.low}, ожидалось 5200×0.9=4680→4700`);
  assert.equal(q.high, 6200, `high=${q.high}, ожидалось 5200×1.2=6240→6200`);
});

await check('low ≤ total ≤ high для всех услуг и классов', () => {
  for (const serviceId of ['engine-bay', 'antichrome', 'polish']) {
    for (const cls of [1, 2, 3, 4, 5]) {
      const q = quote(serviceId, cls);
      assert.ok(q.low <= q.total && q.total <= q.high,
        `${serviceId}/${cls}: low=${q.low}, total=${q.total}, high=${q.high} — порядок нарушен`);
    }
  }
});

// Состав и порядок услуг берём из CONFIG, а не из зашитого списка.
// Раньше тест требовал ровно четыре услуги — и упал, когда в прайс
// добавили бронеплёнку и тонировку. Теперь он проверяет то, что
// действительно важно: quoteAll возвращает ВСЕ услуги из конфига,
// без пропусков и дублей, и в порядке возрастания order.
await check('quoteAll возвращает все услуги из CONFIG в порядке order', async () => {
  const { CONFIG } = await import('../js/config.js');
  const declared = [...CONFIG.pricing.services].sort((a, b) => (a.order || 0) - (b.order || 0));

  const all = quoteAll(3);
  assert.equal(all.length, declared.length,
    `объявлено ${declared.length} услуг, получено ${all.length} предложений`);
  assert.deepEqual(all.map((q) => q.serviceId), declared.map((s) => s.id),
    'порядок или состав услуг разошёлся с CONFIG.pricing.services');

  // Дубли означали бы, что услуга попала в список дважды.
  const ids = all.map((q) => q.serviceId);
  assert.equal(new Set(ids).size, ids.length, `есть дубли: ${ids.join(', ')}`);

  // Каждая услуга обязана иметь цену и название — иначе карточка будет пустой.
  for (const q of all) {
    assert.ok(q.low > 0 && q.total > 0 && q.high > 0,
      `${q.serviceId}: неправдоподобная цена low=${q.low} total=${q.total} high=${q.high}`);
  }
});

// Новые услуги из доработки: бронеплёнка, тонировка, керамика, химчистка.
// Проверяем, что они не просто объявлены, но и посчитаны.
await check('новые услуги присутствуют в расчёте', () => {
  const ids = quoteAll(3).map((q) => q.serviceId);
  for (const expected of ['ppf', 'wrap-full', 'tint', 'tint-athermal', 'ceramic', 'interior']) {
    assert.ok(ids.includes(expected), `услуга "${expected}" отсутствует в quoteAll`);
  }
});

await check('formatRange: для фиксированной цены диапазон схлопывается в «от»', () => {
  const fixed = formatRange(quote('antichrome', 4));
  assert.equal(fixed.fixed, true);
  assert.equal(fixed.low, 20000);
  assert.equal(fixed.high, 20000, 'у фиксированной цены не должно быть верхней границы выше минимума');
  assert.equal(fixed.currency, '₽');
});

await check('formatRange(null) не падает', () => {
  const r = formatRange(null);
  assert.equal(r.low, 0);
  assert.equal(r.high, 0);
});

await check('цены детерминированы: повторный вызов даёт тот же результат', () => {
  const a = quote('engine-bay', 4);
  const b = quote('engine-bay', 4);
  assert.deepEqual(a, b, 'расчёт не идемпотентен');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ИТОГИ
// ─────────────────────────────────────────────────────────────────────────────

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


