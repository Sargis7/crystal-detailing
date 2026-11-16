/**
 * Шина событий приложения.
 *
 * Зачем: модули не должны импортировать друг друга напрямую для «отправки
 * сигналов» — это порождает циклические импорты и жёсткий порядок загрузки.
 * Вместо этого калькулятор объявляет результат, а форма его слушает.
 *
 * @module js/core/events
 */

/**
 * Канонические имена событий. Использовать только эти константы —
 * опечатка в строке события иначе проходит молча.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const EVENTS = Object.freeze({
  /** Смена языка: {lang: 'ru'|'hy'} */
  I18N_CHANGED: 'i18n:changed',
  /** Результат VIN-расчёта: {vehicleInfo, quotes, serviceId} */
  CALC_RESULT: 'calc:result',
  /** Сброс калькулятора. */
  CALC_RESET: 'calc:reset',
  /** Запрос на заполнение формы из калькулятора: {model, carClass, serviceId, prices} */
  FORM_PREFILL: 'form:prefill',
  /** Заявка успешно отправлена: {branch} */
  FORM_SENT: 'form:sent',
  /** Решение по cookie: {value: 'all'|'necessary'} */
  COOKIE_CONSENT: 'cookie:consent',
});

/** @type {Map<string, Set<Function>>} Реестр слушателей: имя события → набор функций. */
const registry = new Map();

/**
 * Подписывает функцию на событие.
 *
 * @param {string} eventName Имя события из EVENTS.
 * @param {Function} handler Обработчик, получающий detail события.
 * @returns {Function} Функция отписки — удобно возвращать из `init()`.
 */
export function on(eventName, handler) {
  if (typeof handler !== 'function') {
    console.warn(`[crystal] на событие "${eventName}" передан не обработчик`);
    return () => {};
  }
  if (!registry.has(eventName)) {
    registry.set(eventName, new Set());
  }
  registry.get(eventName).add(handler);
  return () => off(eventName, handler);
}

/**
 * Отписывает функцию от события.
 *
 * @param {string} eventName Имя события.
 * @param {Function} handler Ранее подписанный обработчик.
 * @returns {void}
 */
export function off(eventName, handler) {
  const listeners = registry.get(eventName);
  if (!listeners) {
    return;
  }
  listeners.delete(handler);
  if (listeners.size === 0) {
    registry.delete(eventName);
  }
}

/**
 * Подписывает функцию на одно срабатывание события.
 *
 * @param {string} eventName Имя события.
 * @param {Function} handler Обработчик.
 * @returns {void}
 */
export function once(eventName, handler) {
  const wrapper = (detail) => {
    off(eventName, wrapper);
    handler(detail);
  };
  on(eventName, wrapper);
}

/**
 * Публикует событие. Ошибка одного слушателя не должна ломать остальные,
 * поэтому каждый вызов обёрнут в try/catch.
 *
 * @param {string} eventName Имя события из EVENTS.
 * @param {*} [detail=null] Произвольные данные события.
 * @returns {void}
 */
export function emit(eventName, detail = null) {
  const listeners = registry.get(eventName);
  if (!listeners || listeners.size === 0) {
    return;
  }
  // Копия набора: слушатель может отписаться прямо во время обхода.
  Array.from(listeners).forEach((handler) => {
    try {
      handler(detail);
    } catch (error) {
      console.error(`[crystal] ошибка в обработчике события "${eventName}":`, error);
    }
  });
}

/**
 * Удаляет все подписки. Нужна только для тестов.
 *
 * @returns {void}
 */
export function reset() {
  registry.clear();
}

export default { on, off, once, emit, reset, EVENTS };
