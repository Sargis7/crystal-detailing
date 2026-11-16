/**
 * Офлайн-расшифровка VIN. Модуль не обращается к DOM и не ходит в сеть —
 * он импортируется и вызывается независимо от интерфейса.
 *
 * ВАЖНО ЧЕСТНО СКАЗАТЬ: это не полноценный коммерческий VIN-декодер,
 * а взвешенная эвристика. WMI-таблица покрывает частые марки, символы 4–8
 * информативны не у всех производителей, год кодируется по-разному до 2000
 * и после 2010. Поэтому результат всегда сопровождается полем confidence,
 * а для нераспознанных случаев предусмотрен ручной выбор класса.
 *
 * @module js/vin/decoder
 */

import { WMI_TABLE, WMI_WILDCARDS, YEAR_CODES, MODEL_PREFIXES } from './data.js';

/**
 * @typedef {Object} VinValidation
 * @property {boolean} valid Пригоден ли VIN к дальнейшей обработке.
 * @property {string|null} errorCode 'required'|'length'|'chars'|'checksum'|null.
 * @property {string[]} invalidChars Найденные недопустимые символы.
 * @property {boolean|null} checksum Результат контрольной суммы; null — неприменима.
 * @property {string} normalized Нормализованный VIN (верхний регистр, без разделителей).
 */

/**
 * @typedef {Object} VehicleInfo
 * @property {string} vin Нормализованный VIN.
 * @property {string|null} make Марка для показа в интерфейсе.
 * @property {string|null} makeEn Марка латиницей — для сопоставления с таблицами.
 * @property {string|null} model Модель.
 * @property {number|null} year Год выпуска.
 * @property {string|null} region Код региона сборки.
 * @property {number} carClass Класс 1–5.
 * @property {boolean} classGuessed true, если класс выставлен по умолчанию.
 * @property {'high'|'medium'|'low'} confidence Достоверность расшифровки.
 * @property {'local'|'api'} source Источник данных.
 * @property {string|null} errorCode Заполняется, если распознать не удалось.
 */

/** Допустимые символы VIN: цифры и латинские буквы без I, O, Q. */
const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]+$/;

/** Полная длина VIN по стандарту ISO 3779. */
const VIN_LENGTH = 17;

/** Веса позиций для расчёта контрольной суммы североамериканских VIN. */
const CHECKSUM_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** Значения букв для контрольной суммы. */
const CHECKSUM_VALUES = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};

/** WMI регионов, для которых контрольная сумма не применяется. */
const NORTH_AMERICAN_PREFIXES = ['1', '4', '5', '2', '3', '7'];

/**
 * Приводит VIN к каноническому виду: верхний регистр,
 * удаляются пробелы, дефисы и прочие разделители.
 *
 * @param {string} raw Пользовательский ввод.
 * @returns {string} Нормализованный VIN.
 */
export function normalizeVin(raw) {
  return String(raw == null ? '' : raw)
    .toUpperCase()
    .replace(/[\s\-–—_.]/g, '');
}

/**
 * Проверяет структуру VIN: наличие, длину, состав символов, контрольную сумму.
 * Никогда не бросает исключений — все проблемы выражаются через errorCode.
 *
 * @param {string} raw Пользовательский ввод.
 * @returns {VinValidation} Результат проверки.
 */
export function validateVin(raw) {
  const vin = normalizeVin(raw);

  if (vin.length === 0) {
    return { valid: false, errorCode: 'required', invalidChars: [], checksum: null, normalized: vin };
  }

  if (vin.length !== VIN_LENGTH) {
    return { valid: false, errorCode: 'length', invalidChars: [], checksum: null, normalized: vin };
  }

  const invalidChars = [];
  if (!VIN_PATTERN.test(vin)) {
    for (const char of vin) {
      if (!/[A-HJ-NPR-Z0-9]/.test(char) && invalidChars.indexOf(char) === -1) {
        invalidChars.push(char);
      }
    }
    return { valid: false, errorCode: 'chars', invalidChars, checksum: null, normalized: vin };
  }

  const checksum = checkNorthAmericanChecksum(vin);
  if (checksum === false) {
    return { valid: false, errorCode: 'checksum', invalidChars: [], checksum, normalized: vin };
  }

  return { valid: true, errorCode: null, invalidChars: [], checksum, normalized: vin };
}

/**
 * Контрольная сумма VIN североамериканского рынка (9-й символ).
 * Для автомобилей иных рынков стандарт не применяется, и функция
 * возвращает null — в этом случае проверка не блокирует работу.
 *
 * @param {string} vin Нормализованный VIN длиной 17 символов.
 * @returns {boolean|null} true/false для проверяемых VIN, null — если неприменимо.
 */
export function checkNorthAmericanChecksum(vin) {
  if (typeof vin !== 'string' || vin.length !== VIN_LENGTH) {
    return null;
  }
  if (NORTH_AMERICAN_PREFIXES.indexOf(vin.charAt(0)) === -1) {
    return null;
  }
  // Не-североамериканские производители с такими WMI тоже существуют,
  // поэтому дополнительно требуем цифру в 9-й позиции.
  const checkChar = vin.charAt(8);
  if (checkChar === 'X') {
    return true;
  }
  if (!/^[0-9]$/.test(checkChar)) {
    return null;
  }

  let sum = 0;
  for (let i = 0; i < VIN_LENGTH; i += 1) {
    const char = vin.charAt(i);
    const value = /[0-9]/.test(char) ? Number(char) : (CHECKSUM_VALUES[char] || 0);
    sum += value * CHECKSUM_WEIGHTS[i];
  }

  const remainder = sum % 11;
  const expected = remainder === 10 ? 'X' : String(remainder);
  return expected === checkChar;
}

/**
 * Определяет год выпуска по 10-му символу VIN.
 * Эпоха выбирается по 7-му символу: для большинства современных
 * автомобилей он означает тип кузова и присутствует только после 2000-х.
 *
 * @param {string} vin Нормализованный VIN.
 * @returns {number|null} Год выпуска или null.
 */
export function decodeYear(vin) {
  if (typeof vin !== 'string' || vin.length < 11) {
    return null;
  }
  const code = vin.charAt(9);
  const before = YEAR_CODES.before2010[code];
  const after = YEAR_CODES.after2010[code];

  if (before === undefined && after === undefined) {
    return null;
  }

  // Эвристика эпохи: 7-й символ цифра или не используется как тип кузова
  // у автомобилей до 2000 года, поэтому при сомнении берём позднюю эпоху —
  // подавляющее большинство машин на дорогах моложе 2010 года.
  const currentYear = new Date().getFullYear();
  if (after !== undefined && after <= currentYear + 1) {
    const plausible = before !== undefined && before > currentYear;
    return plausible ? before : after;
  }
  return before !== undefined ? before : after;
}

/**
 * Определяет марку и регион по первым трём символам VIN.
 * Сначала ищется точное совпадение, затем применяются подстановочные правила.
 *
 * @param {string} vin Нормализованный VIN.
 * @returns {{make: string, makeEn: string, region: string, confidence: 'high'|'medium'}|null}
 */
export function decodeWmi(vin) {
  if (typeof vin !== 'string' || vin.length < 3) {
    return null;
  }
  const wmi = vin.slice(0, 3);
  const exact = WMI_TABLE[wmi];
  if (exact) {
    return { ...exact, confidence: 'high' };
  }

  for (const rule of WMI_WILDCARDS) {
    if (wmi.startsWith(rule.prefix)) {
      return { make: rule.make, makeEn: rule.makeEn, region: rule.region, confidence: 'medium' };
    }
  }
  return null;
}

/**
 * Определяет модель по символам 4–8 VIN.
 *
 * @param {string} vin Нормализованный VIN.
 * @returns {{model: string, confidence: 'high'|'medium'|'low'}|null}
 */
export function decodeModel(vin) {
  if (typeof vin !== 'string' || vin.length < 8) {
    return null;
  }
  const prefix = vin.slice(3, 8);
  const entry = MODEL_PREFIXES[prefix];
  if (entry) {
    return { model: entry.model, confidence: entry.confidence };
  }
  return null;
}

/**
 * Полная офлайн-расшифровка VIN.
 * Функция асинхронная, чтобы совпадать по контракту с сетевым провайдером, —
 * интерфейс не должен знать, откуда пришли данные. Исключений не бросает.
 *
 * @param {string} raw Пользовательский ввод.
 * @returns {Promise<VehicleInfo>} Расшифровка с полем source = 'local'.
 */
export async function decodeVinLocal(raw) {
  const validation = validateVin(raw);
  const vin = validation.normalized;

  /**
   * carClass намеренно не заполняется здесь: класс автомобиля выводится из
   * марки/модели отдельным слоем (pricing.resolveClass), потому что это
   * ценообразование, а не расшифровка VIN. Значение 0 означало бы «вне
   * диапазона 1–5» и ломало бы UI; поэтому оставляем null — потребитель
   * обязан вызвать resolveClass.
   *
   * @type {VehicleInfo}
   */
  const info = {
    vin,
    make: null,
    makeEn: null,
    model: null,
    year: null,
    region: null,
    carClass: null,
    classGuessed: false,
    confidence: 'low',
    source: 'local',
    errorCode: validation.errorCode,
  };

  if (!validation.valid) {
    return info;
  }

  const wmi = decodeWmi(vin);
  const model = decodeModel(vin);
  const year = decodeYear(vin);

  if (wmi) {
    info.make = wmi.make;
    info.makeEn = wmi.makeEn;
    info.region = wmi.region;
    info.confidence = wmi.confidence;
  }
  if (model) {
    info.model = model.model;
    // Модель известна — это самый весомый признак, доверие повышается.
    info.confidence = model.confidence === 'high' ? 'high' : 'medium';
  }
  if (year) {
    info.year = year;
  }

  if (!wmi && !model) {
    info.errorCode = 'unknownApproved';
    info.confidence = 'low';
  }

  return info;
}

export default { normalizeVin, validateVin, checkNorthAmericanChecksum, decodeYear, decodeWmi, decodeModel, decodeVinLocal };
