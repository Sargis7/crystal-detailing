/**
 * Самопроверка цен калькулятора по контрольной таблице заказчика.
 * Запуск: node tools/check-pricing.mjs
 * Используется и QA как готовый тест-кейс.
 */
import fs from 'node:fs';
import path from 'node:path';
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

// ── Фоновые фото услуг ────────────────────────────────────────────────
//
// Проверяем две вещи, каждая из которых уже случалась или почти случилась:
//
//   1) путь задан у КАЖДОЙ услуги. Заказчик просил «девять услуг — девять
//      фото», и карточка без фона на фоне остальных выглядит как недоделка.
//   2) файл по этому пути СУЩЕСТВУЕТ. Опечатка в имени даёт битую картинку,
//      которую видно только в браузере: HTML и CSS при этом валидны, а
//      на сервере 404 прилетает уже в рантайме. Такую ошибку дешевле
//      поймать здесь.
//
// Путь относительный и без ведущего слэша: сайт живёт и в корне домена,
// и на GitHub Pages в подкаталоге /crystal-detailing/, где абсолютный
// путь вида /assets/... увёл бы на чужой корень.
console.log('---');
const services = CONFIG.pricing.services || [];
const rootDir = path.resolve(import.meta.dirname, '..');

const noImage = services.filter((s) => typeof s.image !== 'string' || !s.image.trim());
if (noImage.length) {
  fails += noImage.length;
  console.log(`FAIL  без фонового фото: ${noImage.map((s) => s.id).join(', ')}`);
} else {
  console.log(`PASS  фоновое фото задано у всех ${services.length} услуг`);
}

const missingFiles = [];
const absolutePaths = [];
for (const service of services) {
  const src = typeof service.image === 'string' ? service.image.trim() : '';
  if (!src) {
    continue;
  }
  if (src.startsWith('/') || /^[a-z]+:/i.test(src)) {
    absolutePaths.push(`${service.id} → ${src}`);
    continue;
  }
  if (!fs.existsSync(path.join(rootDir, src))) {
    missingFiles.push(`${service.id} → ${src}`);
  }
}

if (missingFiles.length) {
  fails += missingFiles.length;
  console.log(`FAIL  файла нет на диске: ${missingFiles.join(', ')}`);
} else {
  console.log('PASS  все файлы фонов найдены на диске');
}

if (absolutePaths.length) {
  fails += absolutePaths.length;
  console.log(`FAIL  путь должен быть относительным: ${absolutePaths.join(', ')}`);
} else {
  console.log('PASS  пути относительные (работает и на GitHub Pages в подкаталоге)');
}

console.log('---');
console.log(fails === 0 ? 'ALL ANCHORS PASS' : `${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
