/**
 * Сопоставление автомобиля классу и расчёт ориентировочной стоимости.
 *
 * Формула (задокументирована здесь, потому что это ядро калькулятора):
 *
 *   итого = базоваяЦена × множительКласса   (для услуг с scaleByClass)
 *   итого = базоваяЦена                     (для услуг «от», например антихром)
 *   диапазон = [итого × 0.9 … итого × 1.2], округление до сотен рублей
 *
 * Базовая цена в конфиге указана для КЛАССА 3. Это позволяет держать одну
 * цену на услугу вместо матрицы «услуга × класс», но при этом получать
 * точные опорные значения заказчика: комплекс-мойка класса 2 = 8 500 ₽,
 * детейлинг подкапотного класса 3 = 6 000 ₽.
 *
 * @module js/vin/pricing
 */

import CONFIG, { isPlaceholder } from '../config.js';
import { CLASS_TABLE, MULTIPLIERS, CLASS_LABELS } from './data.js';

/**
 * @typedef {import('./decoder.js').VehicleInfo} VehicleInfo
 */

/**
 * @typedef {Object} PriceQuote
 * @property {string} serviceId Идентификатор услуги.
 * @property {number} carClass Класс автомобиля.
 * @property {number} multiplier Применённый множитель (1 для услуг без масштабирования).
 * @property {boolean} scaled true, если множитель применён.
 * @property {number} basePrice Базовая цена из конфига.
 * @property {number} total Итоговая ориентировочная цена.
 * @property {number} low Нижняя граница диапазона.
 * @property {number} high Верхняя граница диапазона.
 * @property {boolean} fromFixed true, если это цена «от», а не расчёт.
 */

/** Кэш множителей: конфиг читается один раз. */
let multiplierCache = null;

/**
 * Возвращает множители классов: приоритет у конфига,
 * значение по умолчанию — из таблицы данных.
 *
 * @returns {Record<number, number>} Множители для классов 1–5.
 */
function getMultipliers() {
  if (multiplierCache) {
    return multiplierCache;
  }
  const configured = CONFIG && CONFIG.pricing ? CONFIG.pricing.classMultipliers : null;
  multiplierCache = (configured && Object.keys(configured).length > 0) ? configured : MULTIPLIERS;
  return multiplierCache;
}

/**
 * Округляет цену до шага из конфига (по умолчанию — до сотен рублей).
 *
 * @param {number} value Значение.
 * @returns {number} Округлённое значение.
 */
function roundPrice(value) {
  const step = CONFIG && CONFIG.pricing && CONFIG.pricing.roundTo ? CONFIG.pricing.roundTo : 100;
  return Math.round(value / step) * step;
}

/**
 * Определяет класс автомобиля 1–5 по данным расшифровки.
 * Если модель не распознана, возвращает класс по умолчанию и флаг guessed —
 * интерфейс обязан показать подсказку и предложить уточнить класс вручную.
 *
 * @param {VehicleInfo} info Данные расшифровки VIN.
 * @returns {{carClass: number, guessed: boolean, reason: string}} Класс и признак приблизительности.
 */
export function resolveClass(info) {
  const defaultClass = CONFIG && CONFIG.pricing ? CONFIG.pricing.defaultClass : 2;

  if (!info) {
    return { carClass: defaultClass, guessed: true, reason: 'no-data' };
  }

  // Явно заданный класс (ручной выбор пользователя или ответ внешнего API)
  // имеет приоритет над эвристикой по модели.
  if (Number.isInteger(info.carClass) && info.carClass >= 1 && info.carClass <= 5 && !info.classGuessed) {
    return { carClass: info.carClass, guessed: false, reason: 'explicit' };
  }
  const haystack = [info.model, info.make, info.makeEn]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (haystack) {
    for (const rule of CLASS_TABLE) {
      for (const needle of rule.match) {
        // Сравнение по началу слова: «X5» совпадёт с «X5 xDrive», но не с «X50».
        const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle.toLowerCase())}([^a-z0-9]|$)`, 'i');
        if (pattern.test(haystack)) {
          return { carClass: rule.class, guessed: false, reason: rule.reason };
        }
      }
    }
  }

  return { carClass: defaultClass, guessed: true, reason: 'unknown-model' };
}

/**
 * Экранирует спецсимволы регулярного выражения.
 *
 * @param {string} text Исходная строка.
 * @returns {string} Экранированная строка.
 */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Возвращает описание услуги из конфига.
 *
 * @param {string} serviceId Идентификатор услуги.
 * @returns {{id: string, basePrice: number, scaleByClass: boolean, order: number}|null}
 */
function findService(serviceId) {
  const services = (CONFIG && CONFIG.pricing && CONFIG.pricing.services) || [];
  return services.find((service) => service.id === serviceId) || null;
}

/**
 * Рассчитывает предложение по одной услуге для заданного класса.
 *
 * @param {string} serviceId Идентификатор услуги.
 * @param {number} carClass Класс автомобиля 1–5.
 * @returns {PriceQuote|null} Предложение либо null, если услуга не найдена.
 */
export function quote(serviceId, carClass) {
  const service = findService(serviceId);
  if (!service) {
    console.warn(`[crystal] pricing: услуга "${serviceId}" не найдена в CONFIG.pricing.services`);
    return null;
  }

  const cls = Number.isInteger(carClass) && carClass >= 1 && carClass <= 5
    ? carClass
    : (CONFIG.pricing.defaultClass || 2);

  const multipliers = getMultipliers();
  const multiplier = service.scaleByClass ? (multipliers[cls] || 1) : 1;
  const total = roundPrice(service.basePrice * multiplier);
  const lowFactor = CONFIG.pricing.rangeLowFactor || 0.9;
  const highFactor = CONFIG.pricing.rangeHighFactor || 1.2;

  return {
    serviceId: service.id,
    carClass: cls,
    multiplier,
    scaled: Boolean(service.scaleByClass),
    basePrice: service.basePrice,
    total,
    low: roundPrice(total * lowFactor),
    high: roundPrice(total * highFactor),
    fromFixed: !service.scaleByClass,
  };
}

/**
 * Рассчитывает предложения по всем услугам конфига — используется
 * для карточек «ваша цена» и для списка услуг в блоке цен.
 *
 * @param {number} carClass Класс автомобиля 1–5.
 * @returns {PriceQuote[]} Предложения в порядке `order` из конфига.
 */
export function quoteAll(carClass) {
  const services = ((CONFIG && CONFIG.pricing && CONFIG.pricing.services) || [])
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  return services
    .map((service) => quote(service.id, carClass))
    .filter((item) => item !== null);
}

/**
 * Приводит предложение к виду, удобному для интерфейса.
 * Для фиксированных цен возвращает только нижнюю границу «от».
 *
 * @param {PriceQuote} q Предложение.
 * @returns {{low: number, high: number, currency: string, fixed: boolean, total: number}}
 */
export function formatRange(q) {
  const currency = '₽';
  if (!q) {
    return { low: 0, high: 0, currency, fixed: false, total: 0 };
  }
  return {
    low: q.fromFixed ? q.total : q.low,
    high: q.fromFixed ? q.total : q.high,
    currency,
    fixed: q.fromFixed,
    total: q.total,
  };
}

/**
 * Возвращает локализованное название класса автомобиля.
 *
 * @param {number} carClass Класс 1–5.
 * @param {'ru'|'hy'} [lang='ru'] Язык.
 * @returns {string} Название класса.
 */
export function classLabel(carClass, lang = 'ru') {
  const entry = CLASS_LABELS[carClass];
  if (!entry) {
    return '';
  }
  return lang === 'hy' ? entry.hy : entry.ru;
}

/**
 * Проверяет, что калькулятор вообще способен считать:
 * в конфиге должна быть хотя бы одна услуга с заполненной ценой.
 *
 * @returns {{ok: boolean, missing: string[]}} Статус и список проблем.
 */
export function isPricingReady() {
  const missing = [];
  const services = (CONFIG && CONFIG.pricing && CONFIG.pricing.services) || [];
  if (services.length === 0) {
    missing.push('CONFIG.pricing.services (список пуст)');
  }
  services.forEach((service, index) => {
    if (!Number.isFinite(service.basePrice) || service.basePrice <= 0) {
      missing.push(`CONFIG.pricing.services[${index}].basePrice`);
    }
    if (isPlaceholder(service.id)) {
      missing.push(`CONFIG.pricing.services[${index}].id`);
    }
  });
  return { ok: missing.length === 0, missing };
}

export default { resolveClass, quote, quoteAll, formatRange, classLabel, isPricingReady };
