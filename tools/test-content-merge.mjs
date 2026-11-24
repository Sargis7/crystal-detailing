/**
 * Проверяет, как сохранённые из админки правки накладываются на CONFIG.
 *
 * Зачем этот файл. Заказчик открыл сайт и написал «Где фото? Их нет!».
 * Оказалось, что админка сохраняет состав услуг ЦЕЛИКОМ, и раньше
 * сохранённый массив заменял базовый. Любое поле, появившееся в CONFIG
 * позже — как image у услуг, — у всех, кто хоть раз сохранил прайс,
 * молча исчезало. На диске фото были, на сайте нет.
 *
 * Сценарий воспроизводится только в одном состоянии: в хранилище лежит
 * дельта, записанная ДО появления поля. Поэтому проверка здесь, а не
 * в браузере: состояние надо подделать точно.
 *
 * Запуск: node tools/test-content-merge.mjs
 */

import assert from 'node:assert/strict';

// ── Подложка localStorage и window ────────────────────────────────────
//
// store.js проверяет хранилище реальной записью через window.localStorage,
// поэтому одной глобальной переменной localStorage мало: без window
// проверка молча падает в резервную память процесса, и тест «проходит»,
// ничего не проверив. Обе ссылки обязаны указывать на один объект.
const backing = new Map();
const storage = {
  getItem: (key) => (backing.has(key) ? backing.get(key) : null),
  setItem: (key, value) => { backing.set(key, String(value)); },
  removeItem: (key) => { backing.delete(key); },
};
globalThis.window = { localStorage: storage };
globalThis.localStorage = storage;

const { set } = await import('../js/core/store.js');
const { getContent } = await import('../js/core/content.js');
const { CONFIG } = await import('../js/config.js');

const IDS = (CONFIG.pricing.services || []).map((service) => service.id);

/**
 * Кладёт дельту так же, как это делает админка.
 *
 * @param {Array<object>} services Состав услуг в сохранённом виде.
 * @returns {void}
 */
function writeDelta(services) {
  set('overrides', { version: 1, savedAt: new Date().toISOString(), services });
}

/**
 * Услуга в том виде, в каком её пишет persistServices() старой версии —
 * без поля image.
 *
 * @param {string} id Идентификатор.
 * @param {number} index Порядок.
 * @returns {object} Запись услуги.
 */
function legacyService(id, index) {
  return { id, basePrice: 5217, scaleByClass: true, order: index + 1 };
}

let failures = 0;

/**
 * Печатает результат одной проверки.
 *
 * @param {string} title Что проверяем.
 * @param {() => void} body Тело проверки.
 * @returns {void}
 */
function check(title, body) {
  try {
    body();
    console.log(`  OK   ${title}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${title}: ${error.message}`);
  }
}

console.log('\nНаложение сохранённых правок на CONFIG\n');

// ── 1. Главный случай: дельта записана до появления image ─────────────
writeDelta(IDS.map(legacyService));

check('старая дельта без image не стирает фоновые фото', () => {
  const services = getContent().pricing.services;
  const missing = services.filter((service) => !service.image);
  assert.equal(missing.length, 0, `без фото остались: ${missing.map((s) => s.id).join(', ')}`);
});

check('старая дельта без image не ломает количество услуг', () => {
  assert.equal(getContent().pricing.services.length, IDS.length);
});

check('цена из сохранённой дельты применяется', () => {
  const first = getContent().pricing.services[0];
  assert.equal(first.basePrice, 5217);
});

// ── 2. Удаление услуги обязано продолжать работать ────────────────────
writeDelta(IDS.slice(0, -1).map(legacyService));

check('удалённая услуга не возвращается из CONFIG', () => {
  const services = getContent().pricing.services;
  assert.equal(services.length, IDS.length - 1);
  assert.ok(!services.some((service) => service.id === IDS[IDS.length - 1]),
    `вернулась: ${IDS[IDS.length - 1]}`);
});

check('у оставшихся услуг фото сохранились', () => {
  const services = getContent().pricing.services;
  assert.ok(services.every((service) => service.image));
});

// ── 3. Явно снятое фото — это пустая строка, а не «поле не задано» ────
writeDelta(IDS.map((id, index) => ({
  ...legacyService(id, index),
  image: id === IDS[0] ? '' : `assets/gallery/service-${id}.jpg`,
})));

check('пустая строка снимает фото и не подменяется значением из CONFIG', () => {
  const first = getContent().pricing.services.find((service) => service.id === IDS[0]);
  assert.equal(first.image, '');
});

check('у остальных услуг фото на месте', () => {
  const services = getContent().pricing.services.filter((service) => service.id !== IDS[0]);
  assert.ok(services.every((service) => service.image));
});

// ── 4. Без правок вовсе сайт показывает заводские фото ────────────────
set('overrides', { version: 1, savedAt: new Date().toISOString() });

check('без правок все услуги идут с фото из CONFIG', () => {
  const services = getContent().pricing.services;
  assert.equal(services.length, IDS.length);
  assert.ok(services.every((service) => service.image));
});

console.log(`\n${failures === 0 ? 'ВСЁ ПРОЙДЕНО' : `${failures} ОШИБОК`}\n`);
process.exit(failures === 0 ? 0 : 1);
