/**
 * ПРАВКИ С СЕРВЕРА — тонкая обёртка над data/site-overrides.json.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ЗАЧЕМ ЭТОТ ФАЙЛ
 * ──────────────────────────────────────────────────────────────────────────
 * Сайт статический и собирается из GitHub Pages. «Сервера» в привычном
 * смысле нет, но есть репозиторий: админ-панель пишет правки в
 * data/site-overrides.json и коммитит его через GitHub API. Браузер
 * посетителя забирает этот файл и накладывает поверх js/config.js.
 *
 * Поэтому правка, сделанная заказчиком в админке, доезжает до всех
 * посетителей за время пересборки GitHub Pages (обычно 30–60 секунд),
 * без участия разработчика и без ручного переноса JSON.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ПРАВКА config.js
 * ──────────────────────────────────────────────────────────────────────────
 * config.js — исполняемый JS-модуль с комментариями и константой PLACEHOLDER.
 * Генерировать его из браузера значило бы собирать JavaScript строкой, и
 * одна опечатка в генераторе убивала бы сайт целиком (модуль не парсится —
 * значит, не работает ничего). JSON такой риски не несёт: при ошибке
 * `JSON.parse` бросает исключение, мы его ловим, и сайт остаётся на
 * базовых данных. Это осознанный выбор «меньше возможностей, но безопаснее».
 *
 * ──────────────────────────────────────────────────────────────────────────
 * КЭШИРОВАНИЕ
 * ──────────────────────────────────────────────────────────────────────────
 * Файл читается с `cache: 'no-cache'`: GitHub Pages отдаёт статику с
 * агрессивным Cache-Control, и без этого заказчик после своего же коммита
 * видел бы старую цену и решил, что публикация не работает. `no-cache`
 * не запрещает кэш, а требует revalidate — то есть файл всё равно
 * скачивается повторно, но отдаётся дешёвым 304, если не менялся.
 *
 * @module js/core/remote
 */

import { REMOTE_FILE, applyRemote, setRemotePatch } from './content.js';
import * as i18n from './i18n.js';

/**
 * @typedef {Object} RemoteState
 * @property {'idle'|'loaded'|'missing'|'error'} status Результат последней загрузки.
 * @property {string} message Человекочитаемое пояснение для консоли.
 * @property {string[]} applied Какие разделы применились.
 * @property {number} [stamp] Когда загружали (мс с эпохи).
 */

/** @type {RemoteState} Состояние последней загрузки. */
let state = { status: 'idle', message: 'не загружалось', applied: [] };

/**
 * @type {Promise<RemoteState>|null} Промис текущей (или последней) загрузки.
 * boot() не ждёт его: страница должна показаться сразу на базовом конфиге,
 * а правки подхватываются, когда файл придёт.
 */
let pending = null;

/**
 * Возвращает промис последней загрузки. Нужен main.js, чтобы после
 * получения файла пересобрать блоки, зависящие от данных.
 *
 * @returns {Promise<RemoteState>} Промис загрузки (уже разрешённый, если
 *   load() вызывали раньше).
 */
export function ready() {
  return pending || Promise.resolve(getState());
}

/**
 * Возвращает состояние последней загрузки. Используется админкой и
 * диагностикой; посетителю эта информация ни к чему.
 *
 * @returns {RemoteState} Копия состояния.
 */
export function getState() {
  return { ...state, applied: state.applied.slice() };
}

/**
 * Адрес файла правок. Абсолютный, чтобы расчёт шёл от корня сайта:
 * админка живёт в /admin.html, сайт — в /index.html, и относительный
 * путь от разных страниц дал бы разные адреса.
 *
 * @returns {string} URL для fetch.
 */
export function remoteUrl() {
  return new URL(REMOTE_FILE, document.baseURI).href;
}

/**
 * Загружает правки и накладывает их на переданный конфиг.
 *
 * Вызывать ДО инициализации UI: модули читают CONFIG при старте, и
 * накладывать правки после значило бы показать посетителю базовые цены,
 * а потом подменить их рывком.
 *
 * @param {Object} base CONFIG, который нужно обновить (мутируется).
 * @param {{timeout?: number}} [options] Параметры запроса.
 * @returns {Promise<RemoteState>} Итог загрузки.
 */
export function load(base, options = {}) {
  pending = loadInternal(base, options);
  return pending;
}

/**
 * Тело загрузки. Вынесено из load(), чтобы `pending` присваивался до
 * первого await — иначе ready(), вызванный сразу после load(), вернул бы
 * промис с ещё пустым состоянием.
 *
 * @param {Object} base CONFIG, который нужно обновить (мутируется).
 * @param {{timeout?: number}} options Параметры запроса.
 * @returns {Promise<RemoteState>} Итог загрузки.
 */
async function loadInternal(base, options) {
  const timeout = Number.isFinite(options.timeout) ? options.timeout : 4000;
  let response;
  try {
    // AbortController, а не голый fetch: если GitHub Pages отвечает
    // медленно, страница не должна ждать по 30 секунд блокировку тем,
    // что и так показано из config.js.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      response = await fetch(remoteUrl(), {
        cache: 'no-cache',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    state = { status: 'error', message: 'файл правок недоступен', applied: [] };
    console.warn('[crystal] remote: файл правок не загрузился, работаем на config.js', error);
    return getState();
  }

  // 404 — нормальная ситуация для сайта, который ещё не публиковали
  // из админки. Это не ошибка и не повод пугать заказчика в консоли.
  if (response.status === 404) {
    state = { status: 'missing', message: 'файл правок ещё не создан', applied: [] };
    return getState();
  }
  if (!response.ok) {
    state = { status: 'error', message: `HTTP ${response.status}`, applied: [] };
    console.warn(`[crystal] remote: файл правок ответил ${response.status}, работаем на config.js`);
    return getState();
  }

  let patch;
  try {
    patch = await response.json();
  } catch (error) {
    state = { status: 'error', message: 'файл правок содержит некорректный JSON', applied: [] };
    console.error('[crystal] remote: JSON правок повреждён, работаем на config.js', error);
    return getState();
  }

  const result = applyRemote(base, patch);
  // Тот же патч регистрируется в content.js: модули, которые читают
  // данные через getContent() (ui, pricelist, hero-video), узнают о
  // серверных правках только через него — мутация CONFIG им не видна.
  if (result.applied.length) {
    setRemotePatch(patch);
  }

  // ── Тексты интерфейса. Их нельзя накатить молча в CONFIG: словарь
  // живёт в i18n, и оттуда его читает каждый узел с data-i18n. Поэтому
  // правки из файла складываем поверх словаря явно, здесь же.
  //
  // Правило слияния: файл перекрывает словарь, но НЕ перекрывает местную
  // правку — её заказчик сделал позже и, возможно, ещё не опубликовал.
  // Иначе открытая админка теряла бы несохранённые изменения при
  // каждой перезагрузке страницы.
  if (patch && patch.texts && typeof patch.texts === 'object') {
    try {
      const local = i18n.readTextOverrides();
      const merged = {
        ru: { ...((patch.texts.ru) || {}), ...local.ru },
        hy: { ...((patch.texts.hy) || {}), ...local.hy },
      };
      i18n.setTextOverrides(merged);
    } catch (error) {
      console.warn('[crystal] remote: правки текстов не применились', error);
    }
  }
  state = {
    status: result.applied.length ? 'loaded' : 'error',
    message: result.applied.length ? `применено: ${result.applied.join(', ')}` : result.skipped.join('; '),
    applied: result.applied,
    stamp: Date.now(),
  };
  if (result.applied.length) {
    console.info(`[crystal] remote: правки с сервера применены — ${result.applied.join(', ')}`);
  } else {
    console.warn('[crystal] remote: правки не применены —', result.skipped.join('; '));
  }
  return getState();
}

export default {
  load,
  ready,
  getState,
  remoteUrl,
};
