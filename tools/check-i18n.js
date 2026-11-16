#!/usr/bin/env node
/**
 * check-i18n.js — валидатор словарей i18n для проекта crystal-detailing.
 *
 * Проверяет требования PRD R-11 / R-12 / L-06 и правила словаря из
 * docs/ARCHITECTURE.md §3.2:
 *   1. Оба файла (js/i18n/ru.js, js/i18n/hy.js) существуют и парсятся.
 *   2. Наборы ключей совпадают: нет ключей только в ru, нет ключей только в hy.
 *   3. Нет пустых значений ('', null, undefined, пробельная строка).
 *   4. Нет значений, содержащих только placeholder '[ЗАПОЛНИТЬ]'.
 *   5. Ключи в нотации section.element[.sub] (символы a-z0-9-, точки).
 *   6. Ключи, найденные в data-i18n* атрибутах index.html, присутствуют в ru.
 *   7. Ключи, использованные в вызовах t('...') в js/, присутствуют в ru.
 *   8. Предупреждение: hy длиннее ru более чем на 40% (риск C2 — ломает вёрстку).
 *
 * Запуск: node tools/check-i18n.js
 * Код возврата: 0 — чисто (возможны только WARN), 1 — найдены ошибки (ERROR).
 */
'use strict';

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(__filename), '..');

const RU_PATH = join(ROOT, 'js', 'i18n', 'ru.js');
const HY_PATH = join(ROOT, 'js', 'i18n', 'hy.js');
const INDEX_PATH = join(ROOT, 'index.html');

const errors = [];
const warnings = [];
const stats = { ruKeys: 0, hyKeys: 0, usedInHtml: 0, usedInJs: 0, lengthIssues: 0 };

const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

/** Рекурсивный обход *.js в директории (исключая i18n-словари). */
function collectFiles(dir, ext, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '.git') continue;
      collectFiles(full, ext, out);
    } else if (name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

/** Загружает ES-модуль словаря. */
async function loadDict(path, label) {
  if (!existsSync(path)) {
    err(`[${label}] Файл словаря не найден: ${relative(ROOT, path)}`);
    return null;
  }
  try {
    const mod = await import(pathToFileURL(path).href);
    const dict = mod.default ?? mod.dict ?? mod[`${label}Dict`];
    if (!dict || typeof dict !== 'object' || Array.isArray(dict)) {
      err(`[${label}] Модуль не экспортирует объект-словарь (нужен export default {...}): ${relative(ROOT, path)}`);
      return null;
    }
    return dict;
  } catch (e) {
    err(`[${label}] Ошибка при импорте словаря ${relative(ROOT, path)}: ${e.message}`);
    return null;
  }
}

/** Проверка значений на пустоту / placeholder. */
function checkValues(dict, label) {
  for (const [key, value] of Object.entries(dict)) {
    if (value == null) {
      err(`[${label}] Пустое значение (${value}) у ключа "${key}"`);
      continue;
    }
    if (typeof value !== 'string') {
      err(`[${label}] Значение ключа "${key}" не строка: ${typeof value}`);
      continue;
    }
    if (value.trim() === '') {
      err(`[${label}] Значение ключа "${key}" — пустая строка`);
      continue;
    }
    if (value.trim() === '[ЗАПОЛНИТЬ]') {
      err(`[${label}] Значение ключа "${key}" — это placeholder без текста`);
    }
    if (!/^[a-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)*$/.test(key)) {
      warn(`[${label}] Ключ "${key}" не соответствует нотации section.element` +
        ' (допустимо: a-z0-9- и camelCase, разделитель — точка)');
    }
  }
}

/** Ключи из разметки: data-i18n, data-i18n-html, -placeholder, -aria, -title, -value. */
function keysFromHtml() {
  if (!existsSync(INDEX_PATH)) {
    err('index.html не найден — разметка недоступна для проверки data-i18n ключей');
    return new Set();
  }
  const html = readFileSync(INDEX_PATH, 'utf8');
  const keys = new Set();
  const re = /data-i18n(?:-html|-placeholder|-aria|-title|-value)?\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (raw) keys.add(raw);
  }
  stats.usedInHtml = keys.size;
  return keys;
}

/** Ключи из кода: t('key'), t("key"), i18n.t('key'). */
function keysFromJs() {
  const keys = new Set();
  const jsFiles = collectFiles(join(ROOT, 'js'), '.js')
    .filter((f) => !f.includes(`${join('js', 'i18n')}`));
  for (const file of jsFiles) {
    const src = readFileSync(file, 'utf8');
    const re = /\bt\(\s*['"]([a-zA-Z0-9][a-zA-Z0-9._-]*)['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) keys.add(m[1]);
    // также .t('...') и i18n.t("...")
    const re2 = /\.t\(\s*['"]([a-zA-Z0-9][a-zA-Z0-9._-]*)['"]/g;
    while ((m = re2.exec(src)) !== null) keys.add(m[1]);
  }
  stats.usedInJs = keys.size;
  return keys;
}

/** Основная проверка. */
async function main() {
  const ru = await loadDict(RU_PATH, 'ru');
  const hy = await loadDict(HY_PATH, 'hy');

  if (!ru || !hy) {
    report();
    return;
  }

  stats.ruKeys = Object.keys(ru).length;
  stats.hyKeys = Object.keys(hy).length;

  checkValues(ru, 'ru');
  checkValues(hy, 'hy');

  // 2. Расхождение состава ключей — главное требование R-11.
  const ruKeys = new Set(Object.keys(ru));
  const hyKeys = new Set(Object.keys(hy));

  for (const k of ruKeys) if (!hyKeys.has(k)) err(`[hy] Отсутствует ключ, есть в ru: "${k}"`);
  for (const k of hyKeys) if (!ruKeys.has(k)) err(`[ru] Отсутствует ключ, есть в hy: "${k}"`);

  // 6-7. Ключи, использованные в разметке и коде, должны существовать в ru.
  const missingHtml = [];
  for (const k of keysFromHtml()) if (!ruKeys.has(k)) missingHtml.push(k);
  for (const k of missingHtml) err(`[index.html] data-i18n ключ отсутствует в ru.js: "${k}"`);

  const missingJs = [];
  for (const k of keysFromJs()) if (!ruKeys.has(k)) missingJs.push(k);
  for (const k of missingJs) err(`[js] t("${k}") — ключ отсутствует в ru.js`);

  // 9. Длина hy относительно ru (риск C2 — разрушение вёрстки).
  for (const k of ruKeys) {
    if (!hyKeys.has(k)) continue;
    const r = String(ru[k]).length;
    const h = String(hy[k]).length;
    if (r >= 8 && h > r * 1.4) {
      stats.lengthIssues++;
      warn(`[длина] "${k}": hy на ${Math.round(((h - r) / r) * 100)}% длиннее ru (ru=${r}, hy=${h}) — нужен clamp()/перенос`);
    }
  }

  // 4. Непереведённые значения (hy точно совпадает с ru, кроме коротких/латиницы).
  for (const k of ruKeys) {
    if (!hyKeys.has(k)) continue;
    const r = String(ru[k]).trim();
    const h = String(hy[k]).trim();
    if (r === h && r.length > 3 && /[А-Яа-яЁё]/.test(r)) {
      warn(`[перевод] "${k}": hy идентичен ru («${r}») — вероятно, не переведено`);
    }
  }

  report();
}

function report() {
  const line = '─'.repeat(64);
  console.log(line);
  console.log('  check-i18n.js — валидатор словарей crystal-detailing');
  console.log(line);
  console.log(`  Ключей в ru.js: ${stats.ruKeys}   Ключей в hy.js: ${stats.hyKeys}`);
  console.log(`  Ключей в разметке (data-i18n): ${stats.usedInHtml}`);
  console.log(`  Ключей в коде (t('...')): ${stats.usedInJs}`);
  console.log(line);

  if (warnings.length) {
    console.log(`\nПРЕДУПРЕЖДЕНИЯ (${warnings.length}):`);
    warnings.forEach((w) => console.log(`  WARN  ${w}`));
  }

  if (errors.length) {
    console.log(`\nОШИБКИ (${errors.length}):`);
    errors.forEach((e) => console.log(`  ERROR ${e}`));
    console.log(`\nРЕЗУЛЬТАТ: ПРОВАЛ — ${errors.length} ошибок, ${warnings.length} предупреждений`);
    console.log(line);
    process.exitCode = 1;
    return;
  }

  console.log(`\nРЕЗУЛЬТАТ: OK — словари согласованы, пустых ключей нет (${warnings.length} предупреждений)`);
  console.log(line);
}

main().catch((e) => {
  console.error('Критическая ошибка валидатора:', e);
  process.exitCode = 1;
});
