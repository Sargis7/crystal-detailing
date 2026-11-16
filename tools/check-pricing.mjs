/**
 * Самопроверка цен калькулятора по контрольной таблице заказчика.
 * Запуск: node tools/check-pricing.mjs
 * Используется и QA как готовый тест-кейс.
 */
import { quote } from '../js/vin/pricing.js';
import { CONFIG } from '../js/config.js';

/**
 * Контрольная таблица заказчика.
 *
 * ⚠️ Комплекс-мойка («детейлинг мойка») удалена из прайса по просьбе
 * заказчика (ноябрь 2026), поэтому её строка отсюда убрана: тест на
 * несуществующую услугу проверял бы ничто. Единственный оставшийся
 * якорь с известными числами из прайса — подкапотное пространство.
 */
const expected = {
  'engine-bay': { 1: 3900, 2: 5200, 3: 6000, 4: 8100, 5: 11000 },
};
let fails = 0;
for (const [id, table] of Object.entries(expected)) {
  for (const [cls, want] of Object.entries(table)) {
    const got = quote(id, Number(cls)).total;
    const ok = got === want;
    if (!ok) fails++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(14)} класс ${cls} → ${got} (ожидалось ${want})`);
  }
}

console.log('---');
const eb = quote('engine-bay', 3).total;
const ebOk = eb === 6000;
if (!ebOk) fails++;
console.log('опорная точка: подкапотное кл.3 =', eb, ebOk ? 'OK' : 'FAIL');
console.log('defaultClass =', CONFIG.pricing.defaultClass,
  '→ подкапотное =', quote('engine-bay', CONFIG.pricing.defaultClass).total);

// Удалённая услуга не должна вернуться незаметно: если её id снова
// появится в CONFIG, кто-то раскомментировал блок вместо правки прайса.
const hasRemoved = (CONFIG.pricing.services || []).some((s) => s.id === 'complex-wash');
console.log('комплекс-мойка удалена из CONFIG:', hasRemoved ? 'FAIL — вернулась' : 'OK');
if (hasRemoved) fails++;
console.log('---');
console.log(fails === 0 ? 'ALL ANCHORS PASS' : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
