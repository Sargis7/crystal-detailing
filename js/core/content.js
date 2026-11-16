/**
 * СЛОЙ ДАННЫХ ПОВЕРХ CONFIG.
 *
 * Зачем он нужен: админ-панель (admin.html) сохраняет правки в localStorage,
 * а сайт должен показывать уже изменённый контент — без пересборки проекта.
 * Прямо в CONFIG писать нельзя (это статический объект модуля, и правки
 * пропадут при перезагрузке), поэтому между «базой» из config.js и
 * интерфейсом появляется этот слой.
 *
 * МОДЕЛЬ ПРОСТАЯ И НАМЕРЕННО ПЛОСКАЯ:
 *
 *   CONFIG (база, коммитится в git)  ← значения по умолчанию
 *   localStorage crystal_overrides   ← только НЕпустые правки (дельта)
 *   getContent()                     ← мёржим базу и дельту → им пользуется UI
 *
 * Дельтой, а не полной копией, потому что:
 *  - после правки config.js на сервере новые значения подхватятся везде,
 *    где админ их не перекрыл (копия затирала бы правки разработчика);
 *  - в хранилище лежит пара килобайт, а не весь конфиг;
 *  - «Сбросить к заводским» = удалить один ключ.
 *
 * ⚠️ ОГРАНИЧЕНИЕ, О КОТОРОМ НАДО ЗНАТЬ ЗАКАЗЧИКУ.
 * localStorage принадлежит КОНКРЕТНОМУ браузеру. Правки, сделанные в
 * админке на компьютере владельца, НЕ увидят посетители: у них нет этого
 * хранилища. Чтобы изменения стали общими, админка умеет выгружать
 * JSON (кнопка «Скачать config-overrides.json») — файл передаётся
 * разработчику или кладётся на сервер, и уже оттуда попадает в
 * config.js. Без серверной части (SQL/API) иначе не выйдет: сайт
 * статический. Подробнее — в README, раздел «Админ-панель».
 *
 * @module js/core/content
 */

import { CONFIG } from '../config.js';
import * as store from './store.js';

/** Ключ localStorage, под которым лежит дельта. */
export const KEY_OVERRIDES = 'overrides';

/** Версия формата дельты. Нужна, чтобы понимать старые файлы после обновлений. */
export const OVERRIDES_VERSION = 1;

/**
 * @typedef {Object} Overrides
 * @property {number} version Версия формата.
 * @property {string} savedAt ISO-дата последнего сохранения.
 * @property {Record<string, number>} [prices] Переопределённые basePrice по id услуги.
 * @property {Array<Object>} [services] Полная замена списка услуг, если она правилась.
 * @property {Record<string, Object>} [branches] Правки полей филиалов по id.
 * @property {Array<Object>} [branchList] Порядок и состав филиалов, если он правился.
 * @property {Record<string, Object>} [pricelistGroups] Правки разделов прайса.
 * @property {Object} [pricelist] Прочие поля прайса: priceMode, note, updated.
 * @property {Object} [gallery] Фотографии галереи.
 */

/**
 * Глубокая копия простого значения (объекты и массивы). Используется,
 * чтобы интерфейс не мог случайно изменить сам CONFIG — после такой
 * порчи «Сбросить» не помогло бы до перезагрузки страницы.
 *
 * @param {*} value Значение.
 * @returns {*} Копия.
 */
function clone(value) {
  if (Array.isArray(value)) {
    return value.map(clone);
  }
  if (value && typeof value === 'object') {
    /** @type {Record<string, *>} */
    const result = {};
    Object.entries(value).forEach(([key, inner]) => {
      result[key] = clone(inner);
    });
    return result;
  }
  return value;
}

/**
 * Читает дельту из хранилища. Битые данные (старая версия, обрезанный JSON,
 * правка руками) не должны ломать сайт — в таком случае считаем, что
 * правок нет, и пишем предупреждение в консоль.
 *
 * @returns {Overrides} Дельта либо пустая версия.
 */
export function readOverrides() {
  const raw = store.get(KEY_OVERRIDES, null);
  if (!raw || typeof raw !== 'object') {
    return { version: OVERRIDES_VERSION, savedAt: '' };
  }
  if (raw.version !== OVERRIDES_VERSION) {
    console.warn(
      `[crystal] content: в хранилище лежат правки формата v${raw.version}, `
      + `ожидается v${OVERRIDES_VERSION}. Они проигнорированы — сохраните их заново из админки.`
    );
    return { version: OVERRIDES_VERSION, savedAt: '' };
  }
  return raw;
}

/**
 * Сохраняет дельту целиком.
 *
 * @param {Overrides} overrides Новая дельта.
 * @returns {boolean} true, если запись прошла.
 */
export function writeOverrides(overrides) {
  return store.set(KEY_OVERRIDES, {
    ...overrides,
    version: OVERRIDES_VERSION,
    savedAt: new Date().toISOString(),
  });
}

/**
 * Есть ли хоть какие-то правки. По этому признаку админка показывает
 * пометку «на сайте сейчас не заводские данные», а сайт — ничего:
 * посетителю эта информация ни к чему.
 *
 * @returns {boolean} true, если дельта непуста.
 */
export function hasOverrides() {
  const raw = readOverrides();
  return Object.keys(raw).some((key) => key !== 'version' && key !== 'savedAt');
}

/**
 * Сбрасывает правки к заводским значениям из config.js.
 *
 * @returns {void}
 */
export function resetOverrides() {
  store.remove(KEY_OVERRIDES);
}

/**
 * Применяет дельту к базовому конфигу и возвращает результат.
 *
 * Возвращается КОПИЯ, а не CONFIG: интерфейс местами держит ссылку на
 * полученный объект, и общая мутация протекла бы в базу.
 *
 * @returns {typeof CONFIG} Конфиг с учётом сохранённых правок.
 */
export function getContent() {
  const base = clone(CONFIG);
  const overrides = readOverrides();

  // ── Цены отдельных услуг. Ключ — id услуги, значение — basePrice.
  // Список услуг не заменяется целиком: id и порядок остаются из базы,
  // поэтому удаление услуги оформляется отдельной записью services.
  if (overrides.prices && Array.isArray(base.pricing && base.pricing.services)) {
    base.pricing.services.forEach((service) => {
      const price = overrides.prices[service.id];
      if (typeof price === 'number' && Number.isFinite(price) && price >= 0) {
        service.basePrice = price;
      }
    });
  }

  // ── Полный список услуг (добавление и удаление).
  // Учитывается после prices, потому что в сохранённом списке basePrice
  // уже актуален — иначе правка цены потерялась бы при первой смене состава.
  if (Array.isArray(overrides.services) && base.pricing) {
    base.pricing.services = overrides.services.map((service) => clone(service));
  }

  // ── Режим показа цен.
  if (overrides.priceMode === 'fixed' || overrides.priceMode === 'on-request') {
    base.pricing.priceMode = overrides.priceMode;
  }

  // ── Филиалы: правки полей по id.
  if (overrides.branches && typeof overrides.branches === 'object') {
    Object.entries(overrides.branches).forEach(([id, patch]) => {
      if (base.branches[id] && patch && typeof patch === 'object') {
        base.branches[id] = { ...base.branches[id], ...clone(patch), id };
      }
    });
  }

  // ── Состав и порядок филиалов. Массив хранит копии целиком, поэтому
  // добавленный в админке филиал существует только здесь.
  if (Array.isArray(overrides.branchList)) {
    /** @type {Record<string, Object>} */
    const rebuilt = {};
    overrides.branchList.forEach((branch) => {
      if (branch && typeof branch.id === 'string' && branch.id.trim()) {
        rebuilt[branch.id] = { ...base.branches[branch.id], ...clone(branch), id: branch.id };
      }
    });
    if (Object.keys(rebuilt).length) {
      base.branches = rebuilt;
      // Основной филиал обязан существовать: иначе заявки без выбора
      // уходили бы в первый попавшийся чат. Правим тихо, но проверяем.
      if (!Object.prototype.hasOwnProperty.call(rebuilt, base.primaryBranch)) {
        base.primaryBranch = Object.keys(rebuilt)[0];
      }
    }
  }

  // ── Прайс-лист: разделы и тексты.
  if (base.pricelist) {
    if (overrides.pricelist && typeof overrides.pricelist === 'object') {
      const patch = clone(overrides.pricelist);
      if (patch.priceMode === 'fixed' || patch.priceMode === 'on-request') {
        base.pricelist.priceMode = patch.priceMode;
      }
      if (typeof patch.note === 'string') {
        base.pricelist.note = patch.note;
      }
      if (typeof patch.updated === 'string') {
        base.pricelist.updated = patch.updated;
      }
      if (patch.details && typeof patch.details === 'object') {
        base.pricelist.details = { ...base.pricelist.details, ...clone(patch.details) };
      }
    }
    if (Array.isArray(overrides.pricelistGroups)) {
      base.pricelist.groups = overrides.pricelistGroups.map(clone);
    }
  }

  // ── Галерея: список фотографий в порядке показа. Пустой элемент
  // (src === '') означает «оставить premium-заглушку» — так же, как
  // выглядит разметка сейчас.
  if (overrides.gallery && Array.isArray(overrides.gallery.items)) {
    base.gallery = { ...(base.gallery || {}), items: overrides.gallery.items.map(clone) };
  }

  return base;
}

/**
 * Проверяет, что базовый config.js не перестал отвечать ожиданиям,
 * от которых зависит слияние. Вызывается один раз при старте — дешевле
 * одной понятной ошибки в консоли, чем пустого прайса без объяснений.
 *
 * @returns {string[]} Список проблем (пустой, если всё в порядке).
 */
export function validateBaseConfig() {
  const problems = [];
  if (!CONFIG.pricing || !Array.isArray(CONFIG.pricing.services)) {
    problems.push('CONFIG.pricing.services должен быть массивом');
  }
  if (!CONFIG.branches || typeof CONFIG.branches !== 'object') {
    problems.push('CONFIG.branches должен быть объектом');
  }
  if (!Object.prototype.hasOwnProperty.call(CONFIG.branches || {}, CONFIG.primaryBranch)) {
    problems.push(`CONFIG.primaryBranch = "${CONFIG.primaryBranch}" не совпадает ни с одним филиалом`);
  }
  if (!CONFIG.pricelist) {
    problems.push('CONFIG.pricelist отсутствует — прайс-лист не отрисуется');
  }
  // Фон необязателен: без него сайт просто остаётся на градиентах.
  // Но если блок есть и включён, путь к ролику обязан быть заполнен —
  // иначе посетитель получит пустой первый экран без объяснений.
  if (CONFIG.background && CONFIG.background.enabled !== false) {
    const video = CONFIG.background.video;
    const webm = CONFIG.background.videoWebm;
    const filled = (value) => typeof value === 'string' && value.trim() !== '';
    if (!filled(video) && !filled(webm)) {
      problems.push(
        'CONFIG.background.enabled = true, но ни video, ни videoWebm не заполнены — '
        + 'первый экран останется только с постером'
      );
    }
  }
  return problems;
}

export default {
  getContent,
  readOverrides,
  writeOverrides,
  hasOverrides,
  resetOverrides,
  validateBaseConfig,
  KEY_OVERRIDES,
  OVERRIDES_VERSION,
};
