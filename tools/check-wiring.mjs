/**
 * ПРОВЕРКА СВЯЗКИ «РАЗМЕТКА ↔ JS ↔ CSS ↔ СЛОВАРИ».
 *
 * Зачем отдельный тест. Статический сайт без сборщика прощает синтаксические
 * ошибки, но не прощает расхождений: если index.html помечает кнопку
 * data-cookie-reject, а cookie.js ищет data-cookie-decline, то синтаксис
 * чист, тесты модулей зелёные, а отказ от cookie молча не работает.
 * Ровно такие расхождения (а не ошибки в логике) ломали этот проект чаще
 * всего, поэтому они вынесены в отдельную проверку.
 *
 * Что проверяется:
 *  1. Каждый селектор, который JS ищет через $('[data-...]'), существует
 *     в index.html.
 *  2. Каждый атрибут data-i18n, упомянутый в index.html, есть в обоих
 *     словарях (ru и hy).
 *  3. Каждый ключ t('...') из JS-модулей есть в словарях.
 *  4. Каждый CSS-класс, который JS добавляет или удаляет, описан в style.css
 *     (кроме служебных состояний, перечисленных в ALLOWED_MISSING_CSS).
 *
 * Запуск: node tools/check-wiring.mjs
 *
 * @module tools/check-wiring
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Классы, которых сознательно нет в CSS.
 *
 * Здесь только те, что используются как программные маркеры для внешних
 * инструментов или для будущих стилей. Любое добавление сюда — повод
 * спросить, зачем класс нужен, если он ничего не делает.
 */
const ALLOWED_MISSING_CSS = new Set([
  'is-open',        // логическое состояние, оформляется через [hidden]/animation
  'is-loading',     // оформляется через спиннер-элемент, а не класс кнопки
  'has-error',      // основной сигнал — [aria-invalid], класс для подписи
]);

/**
 * Атрибуты, которые сознательно могут отсутствовать в разметке.
 *
 * Это запасные селекторы: код сначала пробует один вариант, потом другой
 * (так сделано там, где разметка и модуль писались в разное время).
 * Отсутствие запасного варианта — норма, отсутствие основного — ошибка,
 * и она всплывёт на первом же из двух.
 */
const OPTIONAL_ATTRS = new Set([
  'data-cookie-banner',
  'data-cookie-decline',
  'data-cookie-settings',
  'data-cookie-reset',
  'data-gallery-src',
  'data-field-error',
  'data-form-branch-hint',
  'data-lightbox-img',
  'data-gallery-grid',
  'data-calc-form',
  'data-calc-to-form',
  'data-calc-range',
  'data-copy',
  'data-copy-label',
  'data-reveal',
  'data-lead-form',
]);

const problems = [];
const checks = { selectors: 0, i18nHtml: 0, i18nJs: 0, cssClasses: 0 };

/**
 * Читает файл проекта.
 *
 * @param {string} relPath Путь относительно корня проекта.
 * @returns {string} Содержимое.
 */
function read(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf8');
}

/**
 * Собирает ВСЮ разметку сайта: index.html, страницы legal/*.html и admin.html.
 *
 * Проверять связку только по index.html недостаточно: js/legal.js ищет
 * маркеры (data-legal-requisite и другие), которых в index.html нет и быть
 * не должно — они живут на юридических страницах. Без их учёта проверка
 * давала ложные срабатывания на корректном коде.
 *
 * admin.html подключается по той же причине: js/admin.js целиком построен
 * на data-атрибутах, которые есть только в панели. Пока файла не было в
 * списке, каждый такой атрибут считался «потерянной связкой».
 *
 * @returns {{name: string, html: string}[]} Разметка и имена файлов.
 */
function readAllMarkup() {
  const out = [{ name: 'index.html', html: read('index.html') }];
  const legalDir = join(ROOT, 'legal');
  if (existsSync(legalDir)) {
    for (const entry of readdirSync(legalDir)) {
      if (entry.endsWith('.html')) {
        out.push({ name: `legal/${entry}`, html: read(join('legal', entry)) });
      }
    }
  }
  if (existsSync(join(ROOT, 'admin.html'))) {
    out.push({ name: 'admin.html', html: read('admin.html') });
  }
  return out;
}

/**
 * Рекурсивно собирает .js файлы в каталоге.
 *
 * @param {string} relDir Каталог относительно корня.
 * @returns {string[]} Пути файлов.
 */
function jsFiles(relDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir))) {
      const rel = join(dir, entry);
      const full = join(ROOT, rel);
      if (statSync(full).isDirectory()) {
        walk(rel);
      } else if (entry.endsWith('.js')) {
        out.push(rel.split('\\').join('/'));
      }
    }
  };
  walk(relDir);
  return out;
}

/**
 * Извлекает ключи словаря из файла js/i18n/*.js.
 *
 * @param {string} relPath Путь к словарю.
 * @returns {Set<string>} Множество ключей.
 */
function dictKeys(relPath) {
  const source = read(relPath);
  const keys = new Set();
  const re = /^\s*'([^']+)':/gm;
  let match;
  while ((match = re.exec(source)) !== null) {
    keys.add(match[1]);
  }
  return keys;
}

const html = read('index.html');
const css = read('css/style.css')
  + (existsSync(join(ROOT, 'css/admin.css')) ? read('css/admin.css') : '');
const ruKeys = dictKeys('js/i18n/ru.js');
const hyKeys = dictKeys('js/i18n/hy.js');

/** Вся разметка сайта: index.html + юридические страницы. */
const markup = readAllMarkup();

/** Склеенный текст разметки — для проверок «есть ли атрибут где угодно». */
const allMarkup = markup.map((m) => m.html).join('\n');

const modules = [
  ...jsFiles('js'),
];

// ─── 1. Селекторы, которые ищет JS ────────────────────────────────────────
// Ищем только «якорные» селекторы по data-атрибуту: они относятся к разметке.
// Селекторы по классам внутри динамически созданных узлов (например,
// '.g-tile__hint') проверяются отдельно — их разметка может создаваться в JS.
const cssInJs = new Set();
for (const file of modules) {
  const source = read(file);
  const re = /(?:\$|\$\$)\(\s*'(\[[^']+\])'/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const selector = match[1];
    checks.selectors += 1;
    // Селектор вида [data-calc-result] — это поиск атрибута. В разметке
    // атрибут записан без скобок, поэтому сравниваем именно имя атрибута.
    const parts = selector.match(/\[([^\]]+)\]/g) || [];
    const raw = parts[0];
    if (!raw) {
      continue;
    }
    const attrName = raw.slice(1, -1).split('=')[0].trim();
    if (OPTIONAL_ATTRS.has(attrName)) {
      continue;
    }
    if (!allMarkup.includes(attrName) && !css.includes(attrName)) {
      problems.push({
        level: 'error',
        text: `${file}: атрибут «${attrName}» не найден ни в разметке сайта, ни в style.css`,
      });
    }
  }

  // Классы, которые модуль вешает через classList.add / toggle / remove.
  const classRe = /classList\.(?:add|remove|toggle)\(\s*'([a-zA-Z0-9_-]+)'/g;
  while ((match = classRe.exec(source)) !== null) {
    cssInJs.add(match[1]);
  }
}

// ─── 2. data-i18n в разметке ──────────────────────────────────────────────
// Обходим все страницы: юридические документы несут сотни ключей, и
// опечатка в одном из них — такая же поломка, как в index.html.
const i18nAttrRe = /data-i18n(?:-html|-placeholder|-aria|-title|-content|-value)?="([^"]+)"/g;
for (const page of markup) {
  let m;
  i18nAttrRe.lastIndex = 0;
  while ((m = i18nAttrRe.exec(page.html)) !== null) {
    const key = m[1];
    checks.i18nHtml += 1;
    if (!ruKeys.has(key)) {
      problems.push({ level: 'error', text: `${page.name}: ключ «${key}» отсутствует в ru.js` });
    }
    if (!hyKeys.has(key)) {
      problems.push({ level: 'error', text: `${page.name}: ключ «${key}» отсутствует в hy.js` });
    }
  }
}

// ─── 3. Ключи t('...') в JS ───────────────────────────────────────────────
for (const file of modules) {
  const source = read(file);
  const re = /\bt\(\s*'([^']+)'/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const key = match[1];
    checks.i18nJs += 1;
    if (!ruKeys.has(key)) {
      problems.push({ level: 'error', text: `${file}: ключ «${key}» отсутствует в ru.js` });
    }
    if (!hyKeys.has(key)) {
      problems.push({ level: 'error', text: `${file}: ключ «${key}» отсутствует в hy.js` });
    }
  }

  // Шаблонные ключи вида t(`calc.class${n}`) и t(`services.${id}.name`) —
  // их нельзя проверить подстановкой, но можно проверить префикс семейства.
  const tplRe = /\bt\(\s*`([^`]+)`/g;
  while ((match = tplRe.exec(source)) !== null) {
    const template = match[1];
    const prefix = template.split('${')[0];
    if (!prefix) {
      continue;
    }
    const hasFamily =
      [...ruKeys].some((k) => k.startsWith(prefix)) &&
      [...hyKeys].some((k) => k.startsWith(prefix));
    if (!hasFamily) {
      problems.push({
        level: 'error',
        text: `${file}: нет ни одного ключа с префиксом «${prefix}» ни в одном словаре`,
      });
    }
  }
}

// ─── 4. CSS-классы, которыми управляет JS ─────────────────────────────────
for (const cls of cssInJs) {
  checks.cssClasses += 1;
  if (ALLOWED_MISSING_CSS.has(cls)) {
    continue;
  }
  if (!css.includes(`.${cls}`)) {
    problems.push({
      level: 'error',
      text: `класс .${cls} добавляется из JS, но не описан в css/style.css`,
    });
  }
}

// ─── 5. Классы из разметки, которые меняет JS ─────────────────────────────
// Обратная проверка: класс есть в HTML как стартовое состояние, а JS его
// снимает — убеждаемся, что он вообще описан в стилях.
const htmlClassRe = /class="([^"]+)"/g;
const htmlClasses = new Set();
for (const page of markup) {
  let m;
  htmlClassRe.lastIndex = 0;
  while ((m = htmlClassRe.exec(page.html)) !== null) {
    m[1].split(/\s+/).forEach((c) => c && htmlClasses.add(c));
  }
}
for (const cls of ['is-active', 'is-disabled', 'has-photo', 'is-revealed']) {
  if (htmlClasses.has(cls) && !css.includes(`.${cls}`)) {
    problems.push({ level: 'warn', text: `класс .${cls} есть в разметке, но не описан в стилях` });
  }
}

// ─── 6. Файлы, на которые ссылается CONFIG ────────────────────────────────
// Путь в конфиге — это обещание, что файл лежит на месте. Опечатка в
// 'assets/video/hero-bg.mp4' не ломает ни синтаксис, ни разметку: сайт
// просто молча остаётся без фона, и заметить это можно лишь глазами в
// браузере. Поэтому пути к видео и постерам проверяются здесь.
//
// Границы блока ищем подсчётом фигурных скобок, а не регэкспом с
// ленивым квантификатором: тот спотыкается о форматирование (пробелы
// после закрывающей скобки, вложенные объекты) и молча возвращает
// null — то есть проверка «проходит», ничего не проверив.
const configSource = read('js/config.js');
const bgStart = configSource.indexOf('background:');
if (bgStart === -1) {
  problems.push({ level: 'error', text: 'в js/config.js не найден блок CONFIG.background' });
} else {
  const braceStart = configSource.indexOf('{', bgStart);
  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < configSource.length; i += 1) {
    const ch = configSource[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { braceEnd = i; break; }
    }
  }

  if (braceStart === -1 || braceEnd === -1) {
    problems.push({ level: 'error', text: 'не удалось определить границы CONFIG.background в js/config.js' });
  } else {
    const body = configSource.slice(braceStart, braceEnd);
    const pathRe = /^\s*(video|videoWebm|poster|posterMobile):\s*'([^']+)'/gm;
    let pm;
    let found = 0;
    while ((pm = pathRe.exec(body)) !== null) {
      found += 1;
      const [, key, value] = pm;
      if (!value.trim() || value.includes('[ЗАПОЛНИТЬ]')) {
        continue;
      }
      if (!existsSync(join(ROOT, value))) {
        problems.push({ level: 'error', text: `CONFIG.background.${key} указывает на «${value}», но файла нет` });
      }
    }
    if (found === 0) {
      problems.push({ level: 'error', text: 'в CONFIG.background не найдено ни одного пути к файлу' });
    }
  }
}

// ─── Отчёт ────────────────────────────────────────────────────────────────
const errors = problems.filter((p) => p.level === 'error');
const warnings = problems.filter((p) => p.level === 'warn');

console.log('Проверка связки разметки, скриптов, стилей и словарей');
console.log('─'.repeat(64));
console.log(`Модулей JS проверено:        ${modules.length}`);
console.log(`Селекторов в JS:             ${checks.selectors}`);
console.log(`Ключей data-i18n в HTML:     ${checks.i18nHtml}`);
console.log(`Ключей t() в JS:             ${checks.i18nJs}`);
console.log(`Классов CSS под управлением: ${checks.cssClasses}`);
console.log(`Ключей в ru.js / hy.js:      ${ruKeys.size} / ${hyKeys.size}`);
console.log('─'.repeat(64));

if (warnings.length) {
  console.log(`\nПРЕДУПРЕЖДЕНИЯ (${warnings.length}):`);
  warnings.forEach((p) => console.log(`  · ${p.text}`));
}

if (errors.length) {
  console.log(`\nОШИБКИ (${errors.length}):`);
  errors.forEach((p) => console.log(`  ✗ ${p.text}`));
  console.log('\nРЕЗУЛЬТАТ: FAIL');
  process.exit(1);
}

console.log('\nРЕЗУЛЬТАТ: OK');
