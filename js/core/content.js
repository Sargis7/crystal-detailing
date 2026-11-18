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
 * Путь к файлу публикации — он же путь в репозитории GitHub.
 *
 * Зачем отдельный файл, а не правка js/config.js напрямую.
 * config.js — это JS-модуль с комментариями и PLACEHOLDER-константой внутри.
 * Чтобы сохранить его из браузера, пришлось бы собирать текст обратно в
 * JavaScript, и любая опечатка в генераторе ломала бы весь сайт (модуль
 * перестал бы парситься — а он нужен каждому посетителю). JSON-файл
 * синтаксически защищён: `JSON.parse` либо проходит, либо нет, и при ошибке
 * сайт молча остаётся на базовых данных из config.js.
 *
 * Перекрытия применяются поверх CONFIG при загрузке (см. applyRemote ниже),
 * поэтому структура здесь зеркалит config.js один в один.
 */
export const REMOTE_FILE = 'data/site-overrides.json';

/**
 * Собирает JSON публикации из текущего состояния данных.
 *
 * Пишем не «дельту браузера», а ПОЛНОЕ актуальное состояние полей, которыми
 * управляет админка. Иначе на сервере оказались бы только те правки, что
 * лежали в localStorage конкретной машины, и настройки, выгруженные с
 * другого компьютера, потерялись бы при первом же коммите.
 *
 * @param {typeof CONFIG} [source] Источник данных; по умолчанию — getContent().
 * @returns {string} Готовый JSON для загрузки в репозиторий.
 */
export function buildRemotePayload(source) {
  const data = source || getContent();
  const social = data.social || {};
  /** @type {Record<string, Record<string, string>>} */
  const branches = {};
  Object.entries(data.branches || {}).forEach(([id, branch]) => {
    branches[id] = {
      city: branch.city || '',
      address: branch.address || '',
      addressExtra: branch.addressExtra || '',
      phone: branch.phone || '',
      phoneRaw: branch.phoneRaw || '',
      mapUrl: branch.mapUrl || '',
    };
  });

  const payload = {
    version: REMOTE_VERSION,
    updatedAt: new Date().toISOString(),
    primaryBranch: data.primaryBranch,
    pricing: {
      priceMode: data.pricing && data.pricing.priceMode,
      services: ((data.pricing && data.pricing.services) || []).map((service) => ({
        id: service.id,
        basePrice: service.basePrice,
        ...(service.name ? { name: service.name } : {}),
        ...(service.desc ? { desc: service.desc } : {}),
      })),
    },
    pricelist: {
      priceMode: data.pricelist && data.pricelist.priceMode,
      note: data.pricelist && data.pricelist.note,
      updated: data.pricelist && data.pricelist.updated,
      details: (data.pricelist && data.pricelist.details) || {},
      groups: ((data.pricelist && data.pricelist.groups) || []).map((group) => ({
        id: group.id,
        title: group.title,
        services: group.services || [],
      })),
    },
    branches,
    gallery: {
      items: ((data.gallery && data.gallery.items) || []).map((item) => ({
        src: item.src || '',
        caption: item.caption || '',
      })),
    },
    social: {
      whatsapp: social.whatsapp || '',
      telegram: social.telegram || '',
      instagram: social.instagram || '',
    },
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Версия формата файла публикации. Отличается от OVERRIDES_VERSION
 * намеренно: это разные документы, и повышать их надо независимо.
 */
export const REMOTE_VERSION = 1;

/**
 * Применяет файл публикации поверх базового конфига — прямо в переданный
 * объект. Модуль работает и в браузере, и в Node (проверки в tools/),
 * поэтому здесь нет обращений к document или window.
 *
 * Правила намеренно консервативные: битое поле пропускается, а не роняет
 * загрузку. Сайт должен открываться даже с повреждённым JSON — он просто
 * покажет базовые данные.
 *
 * @param {typeof CONFIG} base Конфиг, который нужно обновить (мутируется).
 * @param {*} patch Разобранный JSON публикации.
 * @returns {{applied: string[], skipped: string[]}} Что применилось и что нет.
 */
export function applyRemote(base, patch) {
  const applied = [];
  const skipped = [];
  if (!patch || typeof patch !== 'object' || patch.version !== REMOTE_VERSION) {
    skipped.push('файл отсутствует, повреждён или имеет другую версию');
    return { applied, skipped };
  }

  // ── Цены и состав услуг.
  const patchServices = patch.pricing && patch.pricing.services;
  if (Array.isArray(patchServices) && patch.pricing) {
    const byId = new Map(
      ((base.pricing && base.pricing.services) || []).map((service) => [service.id, service])
    );
    patchServices.forEach((priced) => {
      if (!priced || typeof priced.id !== 'string') {
        return;
      }
      const target = byId.get(priced.id);
      if (target) {
        if (typeof priced.basePrice === 'number') {
          target.basePrice = priced.basePrice;
        }
        if (typeof priced.name === 'string' && priced.name.trim()) {
          target.name = priced.name;
        }
        if (typeof priced.desc === 'string' && priced.desc.trim()) {
          target.desc = priced.desc;
        }
        return;
      }
      // Услуга, добавленная в админке: базовой записи нет, создаём.
      base.pricing.services.push({
        id: priced.id,
        basePrice: typeof priced.basePrice === 'number' ? priced.basePrice : 0,
        ...(priced.name ? { name: priced.name } : {}),
        ...(priced.desc ? { desc: priced.desc } : {}),
      });
    });
    // Услуги, которых нет в файле, считаются удалёнными из админки.
    const keep = new Set(patchServices.map((item) => item && item.id));
    base.pricing.services = base.pricing.services.filter((service) => keep.has(service.id));
    if (patch.pricing.priceMode === 'fixed' || patch.pricing.priceMode === 'on-request') {
      base.pricing.priceMode = patch.pricing.priceMode;
      if (base.pricelist) {
        base.pricelist.priceMode = patch.pricing.priceMode;
      }
    }
    applied.push('услуги и цены');
  }

  // ── Прайс-лист: тексты и разделы.
  const patchList = patch.pricelist;
  if (patchList && typeof patchList === 'object' && base.pricelist) {
    if (typeof patchList.note === 'string') {
      base.pricelist.note = patchList.note;
    }
    if (typeof patchList.updated === 'string') {
      base.pricelist.updated = patchList.updated;
    }
    if (patchList.details && typeof patchList.details === 'object') {
      base.pricelist.details = { ...base.pricelist.details, ...patchList.details };
    }
    if (Array.isArray(patchList.groups)) {
      base.pricelist.groups = patchList.groups.map((group) => ({
        ...group,
        services: (group.services || []).slice(),
      }));
    }
    applied.push('прайс-лист');
  }

  // ── Филиалы. Существующие дополняются, новые создаются, пропавшие
  // удаляются — админка умеет всё три действия.
  if (patch.branches && typeof patch.branches === 'object') {
    const rebuilt = {};
    Object.entries(patch.branches).forEach(([id, branch]) => {
      if (!branch || typeof branch !== 'object') {
        return;
      }
      const baseBranch = (base.branches && base.branches[id]) || {};
      rebuilt[id] = {
        ...baseBranch,
        ...branch,
        id,
      };
    });
    if (Object.keys(rebuilt).length) {
      base.branches = rebuilt;
      if (typeof patch.primaryBranch === 'string'
        && Object.prototype.hasOwnProperty.call(rebuilt, patch.primaryBranch)) {
        base.primaryBranch = patch.primaryBranch;
      } else if (!Object.prototype.hasOwnProperty.call(rebuilt, base.primaryBranch)) {
        base.primaryBranch = Object.keys(rebuilt)[0];
      }
      applied.push('филиалы');
    }
  }

  // ── Галерея.
  const galleryItems = patch.gallery && patch.gallery.items;
  if (Array.isArray(galleryItems)) {
    base.gallery = { ...(base.gallery || {}), items: galleryItems.map((item) => ({ ...item })) };
    applied.push('галерея');
  }

  // ── Соцсети: пустая строка — законное значение «ссылка не задана»,
  // поэтому здесь не отличаем пустое от отсутствующего.
  if (patch.social && typeof patch.social === 'object') {
    base.social = { ...(base.social || {}) };
    ['whatsapp', 'telegram', 'instagram'].forEach((network) => {
      if (typeof patch.social[network] === 'string') {
        base.social[network] = patch.social[network];
      }
    });
    applied.push('соцсети');
  }

  return { applied, skipped };
}

/**
 * Переводит опубликованный файл в локальную дельту и записывает её.
 *
 * Зачем не просто applyRemote: applyRemote меняет CONFIG в памяти, а это
 * живёт до перезагрузки. Кнопке «Загрузить из GitHub» нужно, чтобы данные
 * остались в браузере — на другом компьютере, где правки ещё не накопились.
 * Поэтому тот же файл раскладывается в формат localStorage.
 *
 * @param {string} text Содержимое data/site-overrides.json.
 * @returns {boolean} true, если файл разобран и записан.
 */
export function importRemote(text) {
  let patch;
  try {
    patch = JSON.parse(text);
  } catch (error) {
    console.warn('[crystal] content: файл публикации не разобрался', error);
    return false;
  }
  if (!patch || typeof patch !== 'object' || patch.version !== REMOTE_VERSION) {
    console.warn(`[crystal] content: файл публикации версии ${patch && patch.version}, ожидается ${REMOTE_VERSION}`);
    return false;
  }

  /** @type {Overrides} */
  const next = { version: OVERRIDES_VERSION, savedAt: '' };

  const services = patch.pricing && patch.pricing.services;
  if (Array.isArray(services)) {
    // Полная замена списка: файл публикации всегда содержит состав целиком,
    // поэтому частичная дельта только запутала бы «Сбросить».
    next.services = services
      .filter((item) => item && typeof item.id === 'string' && item.id)
      .map((item) => ({
        id: item.id,
        basePrice: typeof item.basePrice === 'number' ? item.basePrice : 0,
        ...(typeof item.name === 'string' && item.name ? { name: item.name } : {}),
        ...(typeof item.desc === 'string' && item.desc ? { desc: item.desc } : {}),
      }));
    if (patch.pricing.priceMode === 'fixed' || patch.pricing.priceMode === 'on-request') {
      next.priceMode = patch.pricing.priceMode;
    }
  }

  if (patch.pricelist && typeof patch.pricelist === 'object') {
    const list = patch.pricelist;
    const pricelist = {};
    if (typeof list.note === 'string') {
      pricelist.note = list.note;
    }
    if (typeof list.updated === 'string') {
      pricelist.updated = list.updated;
    }
    if (list.details && typeof list.details === 'object') {
      pricelist.details = list.details;
    }
    if (Object.keys(pricelist).length) {
      next.pricelist = pricelist;
    }
    if (Array.isArray(list.groups)) {
      next.pricelistGroups = list.groups.map((group) => ({
        ...group,
        services: (group.services || []).slice(),
      }));
    }
  }

  if (patch.branches && typeof patch.branches === 'object') {
    next.branchList = Object.entries(patch.branches)
      .filter(([, branch]) => branch && typeof branch === 'object')
      .map(([id, branch]) => ({ ...branch, id }));
  }

  if (patch.gallery && Array.isArray(patch.gallery.items)) {
    next.gallery = { items: patch.gallery.items.map((item) => ({ ...item })) };
  }

  return writeOverrides(next);
}

/**
 * Серверные правки, уже полученные этой страницей.
 *
 * Хранятся здесь, а не только в мутированном CONFIG, потому что часть
 * модулей (ui.js, pricelist.js, hero-video.js) читает данные через
 * getContent() — то есть «база + дельта из localStorage», — и про
 * мутацию CONFIG они не знают. Пока этот кэш не заполнен, сайт работает
 * на базовых значениях.
 *
 * @type {*} Разобранный data/site-overrides.json либо null.
 */
let remotePatch = null;

/**
 * Запоминает серверные правки, чтобы их видел и getContent().
 *
 * @param {*} patch Разобранный JSON публикации.
 * @returns {void}
 */
export function setRemotePatch(patch) {
  remotePatch = patch && typeof patch === 'object' ? patch : null;
}

/**
 * Забывает серверные правки (нужно тестам и «Сбросить всё»).
 *
 * @returns {void}
 */
export function clearRemotePatch() {
  remotePatch = null;
}

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
 * Порядок важен: сначала серверные правки (их видит весь мир), затем
 * локальная дельта браузера (их видит только владелец, и они свежее).
 * Обратный порядок означал бы, что заказчик нажал «Добавить услугу» в
 * админке, а сайт показал прежний состав из репозитория.
 *
 * Возвращается КОПИЯ, а не CONFIG: интерфейс местами держит ссылку на
 * полученный объект, и общая мутация протекла бы в базу.
 *
 * @returns {typeof CONFIG} Конфиг с учётом сохранённых правок.
 */
export function getContent() {
  const base = clone(CONFIG);
  const overrides = readOverrides();

  // ── Серверные правки — первыми.
  if (remotePatch) {
    applyRemote(base, remotePatch);
  }

  // Дальше локальная дельта накладывается поверх. Исключение одно — режим
  // показа цен: админка пишет его в ДВА места (priceMode и
  // pricelist.priceMode), и дельта, сделанная до появления серверных
  // правок, перебивала бы решение, уже опубликованное в репозитории.
  // Такую дельту считаем устаревшей и уступаем серверу.
  const localModeFresh = !remotePatch
    || !remotePatch.pricing
    || (overrides.priceMode !== remotePatch.pricing.priceMode);

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
  if (localModeFresh && (overrides.priceMode === 'fixed' || overrides.priceMode === 'on-request')) {
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
  buildRemotePayload,
  applyRemote,
  importRemote,
  setRemotePatch,
  clearRemotePatch,
  KEY_OVERRIDES,
  OVERRIDES_VERSION,
  REMOTE_FILE,
  REMOTE_VERSION,
};
