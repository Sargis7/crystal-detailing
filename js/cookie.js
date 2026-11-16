/**
 * Cookie-баннер и согласие на необязательные cookie.
 *
 * ПРАВОВАЯ ЛОГИКА (требования R-50, R-51, L-01…L-03):
 *  - Кнопки «Принять» и «Только необходимые» РАВНОЗНАЧНЫ по видимости и весу.
 *    Тёмный паттерн (когда «Принять» — яркая кнопка, а отказ спрятан текстовой
 *    ссылкой) недопустим: по 152-ФЗ и Закону РА ЗР-49 согласие должно быть
 *    конкретным, информированным и свободным.
 *  - Необязательные cookie и аналитика НЕ подключаются до явного согласия.
 *  - «Только необходимые» — валидный выбор, а не «настройки, которые не работают».
 *  - Выбор хранится в localStorage; повторно баннер не показывается.
 *
 * @module js/cookie
 */

import { $, $$, on, lockScroll } from './core/dom.js';
import { get, set, KEY_COOKIE_CONSENT } from './core/store.js';
import { emit, EVENTS } from './core/events.js';
import { t } from './core/i18n.js';

/** Возможные значения согласия. */
export const CONSENT = Object.freeze({
  /** Согласие на все cookie, включая аналитические. */
  ALL: 'all',
  /** Только технически необходимые. */
  NECESSARY: 'necessary',
});

/**
 * @typedef {Object} ConsentRecord
 * @property {'all'|'necessary'} value Решение пользователя.
 * @property {string} at Дата решения в формате ISO.
 * @property {number} version Версия текста, на которую дано согласие.
 */

/**
 * Версия политики cookie. Если текст баннера или политики меняется
 * существенно, версию нужно поднять — тогда согласие будет запрошено заново,
 * что и требуется по закону.
 *
 * @type {number}
 */
const CONSENT_VERSION = 1;

/**
 * Читает сохранённое решение, если оно сделано для текущей версии текста.
 *
 * @returns {ConsentRecord|null} Запись согласия либо null.
 */
export function getConsent() {
  const raw = get(KEY_COOKIE_CONSENT, null);
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (raw.version !== CONSENT_VERSION) {
    // Текст изменился — прежнее согласие недействительно.
    return null;
  }
  if (raw.value !== CONSENT.ALL && raw.value !== CONSENT.NECESSARY) {
    return null;
  }
  return raw;
}

/**
 * Проверяет, разрешена ли категория необязательных cookie.
 *
 * Любой код, который ставит аналитику, ОБЯЗАН сначала спросить эту функцию.
 *
 * @returns {boolean} true, если необязательные cookie разрешены.
 */
export function allowsOptionalCookies() {
  const consent = getConsent();
  return Boolean(consent && consent.value === CONSENT.ALL);
}

/**
 * Сохраняет решение пользователя и уведомляет подписчиков.
 *
 * @param {'all'|'necessary'} value Решение.
 * @returns {void}
 */
export function saveConsent(value) {
  const record = {
    value,
    at: new Date().toISOString(),
    version: CONSENT_VERSION,
  };
  set(KEY_COOKIE_CONSENT, record);
  emit(EVENTS.COOKIE_CONSENT, { value });
}

/**
 * Скрывает баннер.
 *
 * @param {HTMLElement|null} banner Элемент баннера.
 * @returns {void}
 */
function hideBanner(banner) {
  if (!banner) {
    return;
  }
  banner.hidden = true;
  banner.setAttribute('aria-hidden', 'true');
  // Возвращаем прокрутку: на мобильных баннер мог её блокировать.
  lockScroll(false);
}

/**
 * Инициализирует баннер cookie.
 *
 * @returns {void}
 */
export function init() {
  const banner = $('[data-cookie-bar]') || $('[data-cookie-banner]');
  if (!banner) {
    return;
  }

  const existing = getConsent();
  if (existing) {
    // Решение уже принято — баннер не показываем вовсе.
    banner.setAttribute('aria-hidden', 'true');
    banner.hidden = true;
    emit(EVENTS.COOKIE_CONSENT, { value: existing.value, restored: true });
    return;
  }

  banner.hidden = false;
  banner.setAttribute('aria-hidden', 'false');
  // Анимацию появления ведёт CSS (@keyframes cookie-up), поэтому класс
  // состояния не нужен: достаточно снять hidden.

  const accept = $('[data-cookie-accept]', banner);
  // В разметке кнопка отказа помечена data-cookie-reject. Читаем оба
  // атрибута: опечатка в одном из них не должна приводить к тому, что
  // «Только необходимые» перестанет сохранять отказ — по 152-ФЗ и
  // Закону РА ЗР-49 это нарушение, а не косметический баг.
  const decline = $('[data-cookie-reject]', banner) || $('[data-cookie-decline]', banner);
  const settings = $('[data-cookie-settings]', banner);

  if (accept) {
    on(accept, 'click', () => {
      saveConsent(CONSENT.ALL);
      hideBanner(banner);
    });
  }

  if (decline) {
    on(decline, 'click', () => {
      saveConsent(CONSENT.NECESSARY);
      hideBanner(banner);
    });
  }

  if (settings) {
    // Настройки ведут на страницу cookie-политики, где перечислены категории.
    // Отдельная панель настроек не нужна: у нас всего две категории, и выбор
    // между ними уже сделан двумя равнозначными кнопками.
    on(settings, 'click', () => {
      const link = settings.getAttribute('data-href');
      if (link) {
        window.location.href = link;
      }
    });
  }

  // Кнопка «изменить решение» — требование возможности отозвать согласие.
  // В текущей разметке такой кнопки нет; обработчик остаётся на случай,
  // если заказчик захочет её добавить (достаточно data-cookie-reset).
  $$('[data-cookie-reset]').forEach((button) => {
    on(button, 'click', () => {
      banner.hidden = false;
      banner.setAttribute('aria-hidden', 'false');
      if (accept) {
        accept.focus();
      }
    });
  });
}

/**
 * Подключает аналитику, ЕСЛИ пользователь дал согласие.
 * Вызывается явно из main.js — так видно, что аналитика не грузится сама.
 *
 * @param {() => void} loader Функция, которая вставляет счётчик.
 * @returns {boolean} true, если аналитика была подключена.
 */
export function loadAnalyticsIfAllowed(loader) {
  if (!allowsOptionalCookies()) {
    return false;
  }
  if (typeof loader !== 'function') {
    return false;
  }
  loader();
  return true;
}

export default {
  init,
  getConsent,
  saveConsent,
  allowsOptionalCookies,
  loadAnalyticsIfAllowed,
  CONSENT,
};
