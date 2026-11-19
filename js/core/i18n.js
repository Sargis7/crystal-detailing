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

/**
 * Тексты, отредактированные владельцем через админ-панель.
 *
 * Зачем отдельный слой, а не правка словарей на лету. ruDict и hyDict —
 * это ES-модули: они заморожены на момент импорта и общие для всех
 * вкладок страницы. Записывать в них правки значило бы держать два
 * источника истины и потерять возможность «вернуть как было».
 * Здесь же лежит только то, что человек реально изменил, — поверх словаря.
 *
 * Структура: { ru: { 'hero.title': '…' }, hy: { … } }.
 *
 * @type {{ru: Dict, hy: Dict}}
 */
let textOverrides = { ru: {}, hy: {} };

/**
 * Ключ хранилища, в котором админка держит правки текстов.
 *
 * ВАЖНО: это ключ БЕЗ префикса. store.js сам добавляет 'crystal_', поэтому
 * в localStorage запись окажется как crystal_text_overrides. Если написать
 * здесь 'crystal_text_overrides', получится crystal_crystal_text_overrides —
 * именно на этой ошибке раздел сначала «сохранял» правки в никуда.
 */
const KEY_TEXT_OVERRIDES = 'text_overrides';

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
  // Правка владельца важнее словаря — но только если она непустая и
  // относится к текущему языку. Пустая строка означает «вернуть как было»,
  // а не «показать пустоту».
  const edited = textOverrides[currentLang] && textOverrides[currentLang][key];
  let value = (typeof edited === 'string' && edited !== '') ? edited : dict[key];

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
  const edited = textOverrides[currentLang] && textOverrides[currentLang][key];
  if (typeof edited === 'string' && edited !== '') {
    return true;
  }
  const dict = DICTS[currentLang] || ruDict;
  return typeof dict[key] === 'string' && dict[key] !== '';
}

// ─────────────────────────────────────────────────────────────────────────────
// ПРАВКИ ТЕКСТОВ ИЗ АДМИНКИ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Источник текста по ключу: словарь этого языка, а не текущего.
 *
 * Нужен админке: ей важно показать исходный текст конкретного языка,
 * даже если страница сейчас на другом. Иначе при редактировании
 * армянского заказчик видел бы в поле русский текст.
 *
 * @param {string} lang Код языка.
 * @param {string} key Ключ перевода.
 * @returns {string} Исходная строка словаря ('' если ключа нет).
 */
export function getBaseText(lang, key) {
  const dict = DICTS[lang] || ruDict;
  const value = dict[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Возвращает правку владельца, если она есть.
 *
 * @param {string} lang Код языка.
 * @param {string} key Ключ перевода.
 * @returns {string} Текст правки либо '' — значит «не правили».
 */
export function getOverride(lang, key) {
  const bucket = textOverrides[lang];
  const value = bucket ? bucket[key] : '';
  return typeof value === 'string' ? value : '';
}

/**
 * Действующий текст с учётом правки — без интерполяции параметров.
 *
 * @param {string} lang Код языка.
 * @param {string} key Ключ перевода.
 * @returns {string} Что увидит посетитель.
 */
export function getText(lang, key) {
  const edited = getOverride(lang, key);
  return edited !== '' ? edited : getBaseText(lang, key);
}

/**
 * Все ключи словаря русского языка — он источник истины по составу.
 * Армянский может отставать, но «нет ключа» и «ключ не переведён» —
 * разные вещи, а список нужен общий.
 *
 * @returns {string[]} Отсортированные ключи.
 */
export function allKeys() {
  return Object.keys(ruDict).sort();
}

/**
 * Проверяет полноту перевода: какие ключи есть в русском, но пусты
 * или отсутствуют в другом языке.
 *
 * @param {string} lang Код языка.
 * @returns {string[]} Ключи без перевода.
 */
export function missingIn(lang) {
  const dict = DICTS[lang] || {};
  return Object.keys(ruDict).filter((key) => {
    const value = dict[key];
    return typeof value !== 'string' || value === '';
  });
}

/**
 * Применяет накопленные правки к документу.
 *
 * Вызывается после setLanguage и после того, как админка сохранила
 * изменения в соседней вкладке. Отдельно от applyToDom, потому что
 * applyToDom читает t(), а t() уже учитывает правки — повторный обход
 * нужен лишь для тех узлов, которые могли не перерисоваться.
 *
 * @param {ParentNode} [root=document] Корень обхода.
 * @returns {void}
 */
export function refreshTexts(root = document) {
  applyToDom(root);
}

/**
 * Читает правки текстов из хранилища.
 *
 * Формат намеренно плоский: { ru: {ключ: строка}, hy: {…} }. Никакой
 * вложенности, потому что ключи уже содержат точки, и разбирать их
 * на путь было бы лишним источником ошибок.
 *
 * Битые данные не должны ломать сайт — при любой аномалии пишем
 * предупреждение и считаем, что правок нет.
 *
 * @returns {{ru: Dict, hy: Dict}} Копия правок.
 */
export function readTextOverrides() {
  const raw = store.get(KEY_TEXT_OVERRIDES, null);
  if (!raw || typeof raw !== 'object') {
    return { ru: {}, hy: {} };
  }
  /** @type {{ru: Dict, hy: Dict}} */
  const result = { ru: {}, hy: {} };
  ['ru', 'hy'].forEach((lang) => {
    const bucket = raw[lang];
    if (bucket && typeof bucket === 'object') {
      Object.keys(bucket).forEach((key) => {
        if (typeof bucket[key] === 'string') {
          result[lang][key] = bucket[key];
        }
      });
    }
  });
  return result;
}

/**
 * Записывает правки в хранилище и сразу применяет их к странице.
 *
 * @param {{ru: Dict, hy: Dict}} next Новые правки (заменяют старые целиком).
 * @returns {boolean} true, если запись удалась.
 */
export function writeTextOverrides(next) {
  const clean = { ru: {}, hy: {} };
  ['ru', 'hy'].forEach((lang) => {
    const bucket = next && next[lang];
    if (!bucket || typeof bucket !== 'object') {
      return;
    }
    Object.keys(bucket).forEach((key) => {
      const value = bucket[key];
      // Пустая строка в хранилище не хранится: «вернуть как было» —
      // это отсутствие записи, а не запись с пустым значением.
      if (typeof value === 'string' && value.trim() !== '') {
        clean[lang][key] = value;
      }
    });
  });
  const ok = store.set(KEY_TEXT_OVERRIDES, clean);
  if (ok) {
    setTextOverrides(clean);
  }
  return ok;
}

/**
 * Применяет правки в память и перерисовывает видимый текст.
 *
 * Публичная функция, потому что правки приходят из двух источников:
 * из локального хранилища (админка на этом компьютере) и из файла
 * публикации в репозитории (правки всех, кто работал в панели).
 *
 * @param {{ru?: Dict, hy?: Dict}} patch Правки.
 * @param {Object} [options={}] Опции.
 * @param {boolean} [options.silent=false] Не трогать DOM (для первичной
 *   загрузки, когда разметка ещё не готова — её всё равно переведёт init()).
 * @returns {void}
 */
export function setTextOverrides(patch, options = {}) {
  const { silent = false } = options;
  textOverrides = {
    ru: { ...((patch && patch.ru) || {}) },
    hy: { ...((patch && patch.hy) || {}) },
  };
  if (!silent && initialized) {
    applyToDom(document);
  }
}

/**
 * Сбрасывает все правки текстов.
 *
 * @returns {void}
 */
export function clearTextOverrides() {
  textOverrides = { ru: {}, hy: {} };
  store.remove(KEY_TEXT_OVERRIDES);
  if (initialized) {
    applyToDom(document);
  }
}

/**
 * Сколько правок сделано — для статуса в админке и при «Сбросить всё».
 *
 * @returns {number} Общее число правок в обоих языках.
 */
export function countTextOverrides() {
  return Object.keys(textOverrides.ru).length + Object.keys(textOverrides.hy).length;
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

  // Правки владельца читаем ДО первой отрисовки: иначе посетитель на
  // долю секунды увидит текст из словаря, а потом он подменится. Порядок
  // важен и для случая, когда хранилище вернуло пустоту — setTextOverrides
  // с пустым объектом просто ничего не меняет.
  try {
    textOverrides = readTextOverrides();
  } catch (error) {
    console.warn('[crystal] i18n: правки текстов не прочитались', error);
    textOverrides = { ru: {}, hy: {} };
  }

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

export default {
  init,
  t,
  has,
  setLanguage,
  getLanguage,
  getDict,
  applyToDom,
  resolveInitial,
  sanitizeHtml,
  LANGUAGES,
  // Правки текстов из админки.
  getBaseText,
  getOverride,
  getText,
  allKeys,
  missingIn,
  refreshTexts,
  readTextOverrides,
  writeTextOverrides,
  setTextOverrides,
  clearTextOverrides,
  countTextOverrides,
};
