/**
 * ТОЧКА РАСШИРЕНИЯ ПОД ВНЕШНИЙ API РАСШИФРОВКИ VIN.
 *
 * Это единственный модуль проекта, который знает о существовании внешнего
 * сервиса. Интерфейс вызывает только provider.decode(vin) и никогда не
 * интересуется, откуда пришли данные. Переключение local → api выполняется
 * одной строкой в js/config.js и не требует правок ни в разметке,
 * ни в calculator.js.
 *
 * @module js/vin/provider
 */

import CONFIG, { isPlaceholder } from '../config.js';
import { decodeVinLocal, validateVin } from './decoder.js';
import { resolveClass } from './pricing.js';

/**
 * @typedef {import('./decoder.js').VehicleInfo} VehicleInfo
 */

/**
 * @typedef {Object} VinProvider
 * @property {string} name Имя провайдера: 'local' или 'api'.
 * @property {(vin: string) => Promise<VehicleInfo>} decode Расшифровка VIN.
 */

/**
 * Оборачивает офлайн-декодер в интерфейс провайдера.
 * В сеть не ходит никогда, исключений не бросает.
 *
 * @returns {VinProvider} Провайдер офлайн-расшифровки.
 */
export function createLocalProvider() {
  return {
    name: 'local',
    /**
     * @param {string} vin VIN-код.
     * @returns {Promise<VehicleInfo>} Расшифровка.
     */
    async decode(vin) {
      const info = await decodeVinLocal(vin);
      const resolved = resolveClass(info);
      info.carClass = resolved.carClass;
      info.classGuessed = resolved.guessed;
      info.source = 'local';
      return info;
    },
  };
}

/**
 * Создаёт провайдер внешнего сервиса расшифровки VIN.
 *
 * Обязанности провайдера:
 *  1. соблюдать таймаут CONFIG.vin.apiTimeoutMs — запрос не может висеть вечно;
 *  2. при ошибке, таймауте или пустом ответе тихо откатываться на офлайн-декодер,
 *     если в конфиге включён fallbackToLocal;
 *  3. приводить ответ сервиса к единому типу VehicleInfo, включая carClass.
 *
 * Сервис-контракт предполагает GET {apiBase}/decode?vin=...&key=... и ответ
 * вида { make, model, year, region } — при подключении другого сервиса
 * достаточно поправить normalizeApiResponse ниже.
 *
 * @param {string} apiBase Базовый адрес сервиса.
 * @param {string} apiKey Ключ доступа.
 * @returns {VinProvider} Провайдер внешнего API.
 */
export function createApiProvider(apiBase, apiKey) {
  return {
    name: 'api',

    /**
     * @param {string} vin VIN-код.
     * @returns {Promise<VehicleInfo>} Расшифровка; при сбое — результат локального декодера.
     */
    async decode(vin) {
      const validation = validateVin(vin);
      if (!validation.valid) {
        // Структурно неверный VIN нет смысла отправлять в сеть.
        return createLocalProvider().decode(vin);
      }

      const timeoutMs = CONFIG.vin.apiTimeoutMs || 8000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const url = new URL(String(apiBase).replace(/\/$/, '') + '/decode');
        url.searchParams.set('vin', validation.normalized);
        url.searchParams.set('key', apiKey);

        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const payload = await response.json();
        const normalized = normalizeApiResponse(validation.normalized, payload);

        if (!normalized) {
          throw new Error('пустой ответ сервиса');
        }

        const resolved = resolveClass(normalized);
        normalized.carClass = resolved.carClass;
        normalized.classGuessed = resolved.guessed;
        normalized.source = 'api';
        return normalized;
      } catch (error) {
        console.warn('[crystal] vin: внешний сервис недоступен, используется офлайн-расшифровка:', error.message || error);
        if (CONFIG.vin.fallbackToLocal) {
          return createLocalProvider().decode(vin);
        }
        return {
          vin: validation.normalized,
          make: null,
          makeEn: null,
          model: null,
          year: null,
          region: null,
          carClass: 0,
          classGuessed: false,
          confidence: 'low',
          source: 'api',
          errorCode: 'apiUnavailable',
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Приводит ответ внешнего сервиса к единому типу VehicleInfo.
 *
 * Поддерживает два распространённых формата ответа:
 *  - плоский: { make, model, year, region }
 *  - вложенный: { data: { make, model, year } } (Vincario, NHTSA)
 *
 * @param {string} vin Нормализованный VIN.
 * @param {Object} payload Ответ сервиса.
 * @returns {VehicleInfo|null} Нормализованные данные либо null, если распознать нечего.
 */
function normalizeApiResponse(vin, payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const source = payload.data && typeof payload.data === 'object' ? payload.data : payload;

  const make = source.make || source.manufacturer || source.Manufacturer || null;
  const model = source.model || source.Model || null;
  const rawYear = source.year || source.modelYear || source.ModelYear || null;
  const year = rawYear ? Number(String(rawYear).slice(0, 4)) : null;
  const region = source.region || source.country || source.Country || null;

  if (!make && !model) {
    return null;
  }

  return {
    vin,
    make: make || null,
    makeEn: make || null,
    model: model || null,
    year: Number.isFinite(year) ? year : null,
    region: region || null,
    carClass: 0,
    classGuessed: false,
    confidence: make && model ? 'high' : 'medium',
    source: 'api',
    errorCode: null,
  };
}

/**
 * Фабрика провайдеров. Выбирает реализацию по CONFIG.vin.provider.
 * Если выбран режим 'api', но адрес или ключ не заполнены, выводит
 * предупреждение и откатывается на локальный провайдер: демонстрационная
 * версия сайта не должна падать из-за незаполненного конфига.
 *
 * @returns {VinProvider} Готовый к использованию провайдер.
 */
export function getProvider() {
  const mode = CONFIG.vin.provider;

  if (mode === 'api') {
    const baseMissing = isPlaceholder(CONFIG.vin.apiBase);
    const keyMissing = isPlaceholder(CONFIG.vin.apiKey);

    if (baseMissing || keyMissing) {
      console.warn(
        '[crystal] vin: выбран провайдер "api", но не заполнены CONFIG.vin.apiBase / apiKey. ' +
        'Используется офлайн-расшифровка. Заполните ключи в js/config.js для подключения внешнего сервиса.'
      );
      return createLocalProvider();
    }

    return createApiProvider(CONFIG.vin.apiBase, CONFIG.vin.apiKey);
  }

  return createLocalProvider();
}

export default { createLocalProvider, createApiProvider, getProvider };
