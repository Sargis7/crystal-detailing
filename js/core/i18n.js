/**
 * Движок интернационализации.
 *
 * Как это работает: в разметке текстовые узлы не содержат текста, а несут
 * атрибут data-i18n="ключ". Этот модуль при смене языка обходит документ и
 * подставляет значения из словаря. За счёт этого язык переключается без
 * перезагрузки страницы и разметка существует в единственном экземпляре.
 *
 * Поддерживаемые атрибуты:
 *   data-i18n             → textContent
 *   data-i18n-html        → innerHTML (только для строк с инлайн-разметкой)
 *   data-i18n-placeholder → атрибут placeholder
 *   data-i18n-aria        → атрибут aria-label
 *   data-i18n-title       → атрибут title
 *   data-i18n-value       → атрибут value (для option)
 *
 * @module js/core/i18n
 */

import ruDict from '../i18n/ru.js';
import hyDict from '../i18n/hy.js';
import * as store from './store.js';
import * as events from './events.js';

/** @typedef {Record<string, string>} Dict */

/** @type {Dict} Язык по умолчанию — источник истины по составу ключей. */
const FALLBACK_LANG = 'ru';

/** @type {number} Сколько предупреждений о пропущенных ключах уже выведено. */
const MAX_MISSING_WARNINGS = 25;

/** Словари. Оба загружаются статически: вместе они весят меньше 25 КБ. */
const DICTS = { ru: ruDict, hy: hyDict };

/** @type {string} Текущий язык. */
let currentLang = FALLBACK_LANG;

/** @type {Set<string>} Уже предупреждали об этих ключах — не спамить консоль. */
const warnedKeys = new Set();

/** @type {boolean} Инициализирован ли модуль. */
let initialized = false;

/** Доступные языки и их подписи для переключателя. */
export const LANGUAGES = Object.freeze([
  { code: 'ru', label: 'RU', native: 'Русский', lang: 'ru' },
  { code: 'hy', label: 'HY', native: 'Հայերեն', lang: 'hy' },
]);

/**
 * Подставляет параметры вида {name} в строку.
 *
 * @param {string} template Строка с плейсхолдерами.
 * @param {Object<string, *>} [params={}] Значения.
 * @returns {string} Готовая строка.
 */
function interpolate(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      return String(params[key]);
    }
    return match;
  });
}

/**
 * Возвращает перевод по ключу.
 * Порядок поиска: текущий язык → русский → предупреждение в консоль.
 *
 * @param {string} key Ключ вида 'hero.title'.
 * @param {Object<string, *>} [params={}] Параметры интерполяции.
 * @returns {string} Локализованная строка; пустая строка не возвращается никогда.
 */
export function t(key, params = {}) {
  const dict = DICTS[currentLang] || ruDict;
  let value = dict[key];

  if (value === undefined || value === '') {
    const fallback = ruDict[key];
    if (fallback !== undefined && fallback !== '') {
      if (!warnedKeys.has(key) && warnedKeys.size < MAX_MISSING_WARNINGS) {
        warnedKeys.add(key);
        console.warn(`[crystal] i18n: ключ "${key}" отсутствует в "${currentLang}", подставлен русский текст`);
      }
      value = fallback;
    } else {
      if (!warnedKeys.has(key) && warnedKeys.size < MAX_MISSING_WARNINGS) {
        warnedKeys.add(key);
        console.warn(`[crystal] i18n: отсутствует ключ "${key}"`);
      }
      return key;
    }
  }

  return interpolate(value, params);
}

/**
 * Проверяет существование ключа (без вывода предупреждений).
 *
 * @param {string} key Ключ.
 * @returns {boolean} true, если ключ есть в словаре текущего языка.
 */
export function has(key) {
  const dict = DICTS[currentLang] || ruDict;
  return typeof dict[key] === 'string' && dict[key] !== '';
}

/**
 * Определяет язык при первой загрузке.
 * Приоритет: параметр ?lang= → сохранённый выбор → язык браузера → 'ru'.
 *
 * @returns {string} Код языка.
 */
export function resolveInitial() {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('lang');
    if (fromUrl && DICTS[fromUrl]) {
      return fromUrl;
    }
  } catch (error) {
    console.warn('[crystal] i18n: не удалось прочитать параметр ?lang', error);
  }

  const stored = store.get(store.KEY_LANG, null);
  if (stored && DICTS[stored]) {
    return stored;
  }

  const navLang = (navigator.language || '').toLowerCase();
  if (navLang.startsWith('hy') || navLang.startsWith('arm')) {
    return 'hy';
  }

  return FALLBACK_LANG;
}

/**
 * Возвращает текущий язык.
 *
 * @returns {string} Код языка.
 */
export function getLanguage() {
  return currentLang;
}

/**
 * Возвращает словарь текущего языка (для модулей, которым нужны все ключи сразу).
 *
 * @returns {Dict} Копия словаря.
 */
export function getDict() {
  return { ...(DICTS[currentLang] || ruDict) };
}

/**
 * Применяет переводы ко всем элементам внутри корня.
 *
 * @param {ParentNode} [root=document] Корень обхода.
 * @returns {void}
 */
export function applyToDom(root = document) {
  const scope = root || document;
  if (typeof scope.querySelectorAll !== 'function') {
    return;
  }

  scope.querySelectorAll('[data-i18n]').forEach((node) => {
    const key = node.getAttribute('data-i18n');
    if (key) {
      node.textContent = t(key);
    }
  });

  scope.querySelectorAll('[data-i18n-html]').forEach((node) => {
    const key = node.getAttribute('data-i18n-html');
    if (key) {
      node.innerHTML = sanitizeHtml(t(key));
    }
  });

  scope.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    const key = node.getAttribute('data-i18n-placeholder');
    if (key) {
      node.setAttribute('placeholder', t(key));
    }
  });

  scope.querySelectorAll('[data-i18n-aria]').forEach((node) => {
    const key = node.getAttribute('data-i18n-aria');
    if (key) {
      node.setAttribute('aria-label', t(key));
    }
  });

  scope.querySelectorAll('[data-i18n-title]').forEach((node) => {
    const key = node.getAttribute('data-i18n-title');
    if (key) {
      node.setAttribute('title', t(key));
    }
  });

  scope.querySelectorAll('[data-i18n-value]').forEach((node) => {
    const key = node.getAttribute('data-i18n-value');
    if (key) {
      node.setAttribute('value', t(key));
      if (node.tagName === 'OPTION') {
        node.textContent = t(key);
      }
    }
  });
}

/**
 * Разрешает к инлайн-разметке только безопасный белый список тегов.
 * Защищает от попадания произвольного HTML в словарь или в данные пользователя.
 *
 * @param {string} html Исходная строка.
 * @returns {string} Очищенная строка.
 */
export function sanitizeHtml(html) {
  const allowed = /^(<\/?(b|i|br|a|strong|span)(\s[^>]*)?>)$/i;
  return String(html)
    .split(/(<[^>]*>)/g)
    .map((chunk) => {
      if (chunk.startsWith('<')) {
        return allowed.test(chunk.trim()) ? chunk : '';
      }
      return chunk;
    })
    .join('');
}

/**
 * Переключает язык: сохраняет выбор, обновляет документ, рассылает событие.
 * Если язык уже активен — выходит сразу, чтобы не гонять DOM впустую.
 *
 * @param {string} lang Код языка ('ru' или 'hy').
 * @param {Object} [options={}] Опции.
 * @param {boolean} [options.persist=true] Сохранять ли выбор в localStorage.
 * @returns {void}
 */
export function setLanguage(lang, options = {}) {
  const { persist = true } = options;
  const next = DICTS[lang] ? lang : FALLBACK_LANG;

  if (next === currentLang && initialized) {
    return;
  }

  currentLang = next;

  if (persist) {
    store.set(store.KEY_LANG, next);
  }

  document.documentElement.setAttribute('lang', next);
  // Армянский — язык с письмом слева направо, dir менять не требуется.
  document.documentElement.setAttribute('dir', 'ltr');

  applyToDom(document);
  updateLangSwitcher();

  events.emit(events.EVENTS.I18N_CHANGED, { lang: next });
}

/**
 * Обновляет состояние кнопок переключателя языка.
 *
 * @returns {void}
 */
function updateLangSwitcher() {
  document.querySelectorAll('[data-lang-switch]').forEach((button) => {
    const isActive = button.getAttribute('data-lang-switch') === currentLang;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    if (isActive) {
      button.setAttribute('aria-current', 'true');
    } else {
      button.removeAttribute('aria-current');
    }
  });
}

/**
 * Инициализация: определяет язык и применяет его СИНХРОННО.
 * Синхронность критична — иначе посетитель увидит вспышку русского текста.
 * Также вешает обработчик клика по кнопкам data-lang-switch.
 *
 * @returns {string} Установленный язык.
 */
export function init() {
  const initial = resolveInitial();
  currentLang = initial;
  initialized = true;

  document.documentElement.setAttribute('lang', initial);
  document.documentElement.setAttribute('dir', 'ltr');
  applyToDom(document);
  updateLangSwitcher();

  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-lang-switch]');
    if (!button) {
      return;
    }
    event.preventDefault();
    setLanguage(button.getAttribute('data-lang-switch'));
  });

  events.emit(events.EVENTS.I18N_CHANGED, { lang: initial });
  return initial;
}

export default { init, t, has, setLanguage, getLanguage, getDict, applyToDom, resolveInitial, sanitizeHtml, LANGUAGES };
