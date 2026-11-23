/**
 * АДМИН-ПАНЕЛЬ.
 *
 * Отдельная страница (admin.html), а не часть index.html: инструмент
 * заказчика не должен попадать в сборку сайта, в его вес и в поисковую
 * выдачу. Разметка — в admin.html, стили — в css/admin.css, данные —
 * через js/core/content.js (тот же слой, который читает сайт).
 *
 * ГЛАВНОЕ ОГРАНИЧЕНИЕ, ПРО КОТОРОЕ НАДО ПОМНИТЬ ПРИ ЛЮБОЙ ПРАВКЕ:
 * localStorage принадлежит конкретному браузеру. Здесь нет и не может быть
 * «общей» базы, потому что сайт статический. Поэтому панель:
 *   — показывает, что правки видны только в этом браузере;
 *   — умеет выгрузить JSON, который разработчик переносит в config.js;
 *   — не притворяется, что публикует изменения.
 * Притворяться было бы хуже: заказчик решил бы, что цены на сайте уже
 * обновились, и узнал бы об обратном от клиента.
 *
 * ДАННЫЕ ЧИТАЮТСЯ И ПИШУТСЯ ЦЕЛИКОМ. Сохраняем не «изменённое поле»,
 * а всю дельту (см. content.js). Так не бывает состояния, где часть
 * правок применилась, а часть — нет.
 *
 * @module js/admin
 */

import { CONFIG } from './config.js';
import {
  getContent,
  readOverrides,
  writeOverrides,
  resetOverrides,
  hasOverrides,
  buildRemotePayload,
  importRemote,
} from './core/content.js';
import {
  readSettings as readPublishSettings,
  writeSettings as writePublishSettings,
  isConfigured as publishConfigured,
  writeRemote,
  readRemote,
  checkAccess,
  PublishError,
} from './admin-github.js';
import { $, el, setText, setAttr, on } from './core/dom.js';
// i18n подключён НЕ для переводов админки — она остаётся русской навсегда.
// Он нужен как хранилище словарей: раздел «Тексты сайта» читает из него
// исходные строки обоих языков и пишет правки, которые видит сайт.
// Разделение важное: подписи панели — литералы в этом файле, а объект
// i18n используется как API словаря, а не как переводчик интерфейса.
import * as i18n from './core/i18n.js';
import * as store from './core/store.js';

/** @type {Object} Рабочая копия конфига — из неё всё и рендерится. */
let content = null;

/**
 * @type {Object} Дельта, которую сохраняем.
 * content — то, что уже сохранено вместе с базой; draft — черновик
 * изменений, который уходит в хранилище целиком.
 */
let draft = null;

// ─────────────────────────────────────────────────────────────────────────────
// УТИЛИТЫ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Показывает короткое подтверждение действия.
 *
 * @param {string} message Текст.
 * @param {'ok'|'err'} [tone='ok'] Тон.
 * @returns {void}
 */
function toast(message, tone = 'ok') {
  const node = $('[data-toast]');
  if (!node) {
    return;
  }
  setText(node, message);
  setAttr(node, 'data-tone', tone);
  setAttr(node, 'hidden', null);
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => setAttr(node, 'hidden', ''), 2800);
}

/**
 * Приводит ввод к безопасному идентификатору: латиница, цифры, дефис.
 * ID участвует в ключе перевода services.<id>.name и в data-атрибутах,
 * поэтому пробелы, кириллица и кавычки в нём недопустимы.
 *
 * @param {string} value Ввод пользователя.
 * @returns {string} Нормализованный id.
 */
function toId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Проверяет число цены.
 *
 * @param {*} value Ввод.
 * @returns {number|null} Целое число либо null, если ввод некорректен.
 */
function parsePrice(value) {
  const raw = String(value == null ? '' : value)
    .replace(/[\s\u00A0]/g, '')
    .replace(',', '.');
  if (raw === '') {
    return null;
  }
  const num = Number(raw);
  return Number.isFinite(num) && num >= 0 ? Math.round(num) : null;
}

/**
 * Сохраняет черновик и перерисовывает интерфейс под сохранённое состояние.
 *
 * @param {string} [message] Текст подтверждения; без него тоста не будет.
 * @returns {void}
 */
function commit(message) {
  const ok = writeOverrides(draft);
  if (!ok) {
    toast('Не удалось сохранить в браузере. Проверьте, не открыт ли сайт в приватном режиме.', 'err');
    return;
  }
  // Перечитываем из хранилища, а не доверяем памяти: так интерфейс
  // показывает ровно то, что увидит сайт, включая слияние с базой.
  content = getContent();
  draft = readOverrides();
  renderAll();
  updateStatus();
  if (message) {
    toast(message);
  }
  // Публикация идёт ПОСЛЕ отрисовки и не блокирует её: сохранение в браузере
  // уже состоялось, и даже если GitHub недоступен, панель остаётся рабочей.
  // Промис намеренно не ждём — иначе каждое нажатие кнопки «+10» подвисало
  // бы на время сетевого запроса.
  publishNow(message);
}

// ─────────────────────────────────────────────────────────────────────────────
// ПУБЛИКАЦИЯ В GITHUB
// ─────────────────────────────────────────────────────────────────────────────

/** @type {number} Счётчик изменений — по нему отсекаются устаревшие ответы. */
let publishSeq = 0;

/** @type {{sha: string, commitUrl: string, at: number}|null} Итог последнего коммита. */
let lastPublish = null;

/** @type {string|null} Текст последней ошибки публикации. */
let publishError = null;

/** @type {boolean} Идёт ли запрос прямо сейчас. */
let publishing = false;

/**
 * Отправляет текущее состояние в репозиторий.
 *
 * Почему не ждём: заказчик правит цены пачкой, и каждый клик уходил бы в
 * сеть. GitHub Contents API не умеет «склеивать» коммиты, поэтому вместо
 * очереди используется счётчик: ответ на устаревший запрос отбрасывается,
 * а состояние для коммита всегда берётся заново из localStorage. Итог:
 * последний коммит гарантированно содержит последнюю правку.
 *
 * @param {string} [note] Человеческая причина коммита («Цены», «Филиалы»).
 * @returns {Promise<void>}
 */
async function publishNow(note) {
  const settings = readPublishSettings();

  // Без токена публиковать нечем. Это штатная ситуация: панель могут
  // открыть на чужом компьютере, и тогда правки просто лягут в браузер.
  if (!settings.enabled || !publishConfigured(settings)) {
    publishError = null;
    updateStatus();
    return;
  }

  const seq = (publishSeq += 1);
  publishing = true;
  publishError = null;
  updateStatus();

  const stamp = new Date();
  const when = stamp.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const message = `admin: ${note ? `${note} — ` : ''}${when}`;

  try {
    const text = buildRemotePayload(getContent());
    const result = await writeRemote(settings, text, message);
    if (seq !== publishSeq) {
      // Пока запрос летел, заказчик успел нажать ещё раз — этот ответ
      // устарел, статус показывать нельзя: он протрёт более свежий.
      return;
    }
    lastPublish = { sha: result.sha, commitUrl: result.commitUrl, at: Date.now(), unchanged: result.unchanged };
    if (!result.unchanged) {
      toast('Опубликовано на сайте — обновится в течение минуты');
    }
  } catch (error) {
    if (seq !== publishSeq) {
      return;
    }
    publishError = error instanceof PublishError
      ? error.message
      : 'Не удалось опубликовать изменения. Подробности в консоли.';
    console.error('[crystal] admin: публикация не удалась', error);
    toast(publishError, 'err');
  } finally {
    if (seq === publishSeq) {
      publishing = false;
      updateStatus();
    }
  }
}

/**
 * Раскрывает или сворачивает блок настроек публикации.
 *
 * @returns {void}
 */
function togglePublishPanel() {
  const body = $('[data-publish-body]');
  const button = $('[data-action="toggle-publish"]');
  if (!body) {
    return;
  }
  const willOpen = body.hasAttribute('hidden');
  if (willOpen) {
    setAttr(body, 'hidden', null);
  } else {
    setAttr(body, 'hidden', '');
  }
  if (button) {
    setAttr(button, 'aria-expanded', willOpen ? 'true' : 'false');
    setText(button, willOpen ? 'Свернуть' : 'Настроить');
  }
}

/**
 * Показывает итог проверки или загрузки под кнопками настроек.
 *
 * @param {string} text Текст.
 * @param {'ok'|'err'} [tone='ok'] Тон.
 * @returns {void}
 */
function publishResult(text, tone = 'ok') {
  const node = $('[data-publish-result]');
  if (!node) {
    return;
  }
  setText(node, text);
  setAttr(node, 'data-tone', tone);
  setAttr(node, 'hidden', null);
}

/**
 * Заполняет поля настроек из хранилища. Вызывается при старте и после
 * сохранения, чтобы форма всегда показывала то, что реально применяется.
 *
 * @returns {void}
 */
function renderPublishSettings() {
  const settings = readPublishSettings();
  ['owner', 'repo', 'branch', 'path', 'token'].forEach((name) => {
    const input = document.querySelector(`[data-publish-body] [name="${name}"]`);
    if (input) {
      input.value = settings[name] || '';
    }
  });
  const enabled = document.querySelector('[data-publish-body] [name="enabled"]');
  if (enabled) {
    enabled.checked = settings.enabled !== false;
  }
}

/**
 * Читает форму настроек, проверяет и сохраняет.
 *
 * Токен не обрезается по краям «на всякий случай» — только trim: у
 * fine-grained токенов нет пробелов внутри, а лишний перевод строки
 * при копировании встречается постоянно и ломает заголовок Authorization.
 *
 * @returns {void}
 */
function savePublishSettings() {
  const read = (name) => {
    const input = document.querySelector(`[data-publish-body] [name="${name}"]`);
    return input ? String(input.value || '').trim() : '';
  };

  const next = {
    owner: read('owner') || 'Sargis7',
    repo: read('repo') || 'crystal-detailing',
    branch: read('branch') || 'main',
    path: read('path') || 'data/site-overrides.json',
    token: read('token'),
    enabled: (() => {
      const input = document.querySelector('[data-publish-body] [name="enabled"]');
      return input ? input.checked : true;
    })(),
  };

  if (!writePublishSettings(next)) {
    publishResult('Не удалось сохранить настройки: браузер блокирует запись.', 'err');
    return;
  }
  renderPublishSettings();
  publishResult(next.token
    ? 'Настройки сохранены. Теперь каждое изменение уходит в GitHub.'
    : 'Настройки сохранены, но токен пуст — публикации не будет.', next.token ? 'ok' : 'err');
  updateStatus();

  // Если токен появился только сейчас, а правки уже накоплены в браузере —
  // логично сразу их опубликовать, не заставляя искать, что бы ещё изменить.
  if (next.token && next.enabled && hasOverrides()) {
    publishNow('публикация накопленных правок');
  }
}

/**
 * Кнопка «Проверить подключение»: подтверждает токен и права на репозиторий.
 *
 * @returns {Promise<void>}
 */
async function runCheckAccess() {
  const settings = readPublishSettings();
  if (!publishConfigured(settings)) {
    publishResult('Сначала впишите токен и нажмите «Сохранить настройки».', 'err');
    return;
  }
  publishResult('Проверяю…');
  try {
    const info = await checkAccess(settings);
    const branchNote = info.defaultBranch && info.defaultBranch !== settings.branch
      ? ` Внимание: основная ветка репозитория — ${info.defaultBranch}, а в настройках указана ${settings.branch}.`
      : '';
    publishResult(
      `Подключение работает. Токен принадлежит ${info.login}.${branchNote}`
      + (info.canWrite ? '' : ' У токена нет права записи — коммит не пройдёт.'),
      info.canWrite && !branchNote ? 'ok' : 'err'
    );
  } catch (error) {
    publishResult(
      error instanceof PublishError ? error.message : 'Проверка не удалась. Подробности в консоли.',
      'err'
    );
  }
}

/**
 * Кнопка «Загрузить из GitHub»: забирает опубликованный файл в этот браузер.
 *
 * Нужна в двух случаях: переехали на другой компьютер (правки уже на сайте,
 * но не в localStorage) или файл правили снаружи. Настройка применяется
 * через applyRemote изнутри content.js — вручную формат не разбираем.
 *
 * @returns {Promise<void>}
 */
async function pullFromGithub() {
  const settings = readPublishSettings();
  if (!publishConfigured(settings)) {
    publishResult('Сначала впишите токен и нажмите «Сохранить настройки».', 'err');
    return;
  }
  publishResult('Читаю файл из GitHub…');
  try {
    const remote = await readRemote(settings);
    if (!remote.text) {
      publishResult('В репозитории ещё нет файла правок — публиковать нечего.', 'err');
      return;
    }
    const applied = importRemote(remote.text);
    if (!applied) {
      publishResult('Файл в репозитории повреждён — разобрать его не удалось.', 'err');
      return;
    }
    // Тексты importRemote кладёт в отдельный ключ хранилища; в память
    // движка их надо перечитать явно, иначе панель покажет старые строки.
    i18n.setTextOverrides(i18n.readTextOverrides());
    content = getContent();
    draft = readOverrides();
    renderAll();
    updateStatus();
    publishResult('Данные из GitHub загружены в панель.', 'ok');
  } catch (error) {
    publishResult(
      error instanceof PublishError ? error.message : 'Не удалось прочитать файл. Подробности в консоли.',
      'err'
    );
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// СТАТУС ХРАНИЛИЩА
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Проверяет, пишется ли localStorage. Отдельная проба, а не доверие
 * к наличию объекта: в приватном режиме Safari объект есть, а запись
 * бросает исключение.
 *
 * @returns {boolean} true, если хранилище доступно.
 */
function storageWorks() {
  try {
    window.localStorage.setItem('crystal__admin_probe', '1');
    window.localStorage.removeItem('crystal__admin_probe');
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Обновляет строку статуса под заголовком.
 *
 * Строка честно различает три состояния: правки только в браузере (нет
 * токена), публикация идёт, правки уже в GitHub. Заказчику важно понимать,
 * видит ли изменение кто-то кроме него, — иначе он будет ждать «а почему
 * на телефоне старая цена».
 *
 * @returns {void}
 */
function updateStatus() {
  const node = $('[data-admin-status]');
  if (!node) {
    return;
  }
  if (!storageWorks()) {
    setText(node, 'Хранилище недоступно — правки не сохранятся. Откройте страницу не в приватном режиме.');
    setAttr(node, 'data-tone', 'err');
    return;
  }

  const saved = draft && draft.savedAt ? new Date(draft.savedAt) : null;
  const when = saved
    ? saved.toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    })
    : '';

  const settings = readPublishSettings();
  const connected = settings.enabled && publishConfigured(settings);

  if (publishing) {
    setText(node, 'Сохраняю в GitHub…');
    setAttr(node, 'data-tone', 'busy');
    return;
  }

  if (publishError) {
    setText(node, `Не опубликовано: ${publishError}`);
    setAttr(node, 'data-tone', 'err');
    return;
  }

  if (!connected) {
    // Правки текстов живут в отдельном ключе хранилища и в hasOverrides()
    // не попадают, поэтому их считаем отдельно: иначе владелец поправил
    // бы заголовок в «Текстах сайта» и увидел «данные заводские».
    const textCount = i18n.countTextOverrides();
    if (hasOverrides() || textCount) {
      const textNote = textCount ? ` Текстов изменено: ${textCount}.` : '';
      setText(node, `Есть правки от ${when}.${textNote} Видны только в этом браузере — добавьте токен GitHub, чтобы публиковать.`);
      setAttr(node, 'data-tone', 'warn');
    } else {
      setText(node, 'Показаны заводские данные из config.js. Публикация не настроена.');
      setAttr(node, 'data-tone', null);
    }
    return;
  }

  if (lastPublish) {
    const at = new Date(lastPublish.at).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    if (lastPublish.unchanged) {
      setText(node, 'Опубликовано в GitHub — изменений не было, новый коммит не создавался.');
    } else {
      setText(node, `Опубликовано в GitHub ${at}. Сайт обновится в течение минуты.`);
    }
    setAttr(node, 'data-tone', 'ok');
    return;
  }

  setText(node, hasOverrides()
    ? `Есть правки от ${when}. Публикация в GitHub подключена.`
    : 'Показаны заводские данные из config.js. Публикация в GitHub подключена.');
  setAttr(node, 'data-tone', hasOverrides() ? 'warn' : null);
}

// ─────────────────────────────────────────────────────────────────────────────
// ЦЕНЫ И УСЛУГИ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Человекочитаемое название услуги.
 *
 * У услуг из config.js поля name нет вовсе — название живёт в словарях
 * под ключом services.<id>.name. Без этого поиска таблица показывала бы
 * голые идентификаторы (engine-bay, ppf) вместо названий, и заказчик не
 * понимал бы, какую строку он правит.
 *
 * Услуги, добавленные в админке, name имеют — и он приоритетнее словаря,
 * иначе правка названия не была бы видна.
 *
 * @param {Object} service Запись из pricing.services.
 * @returns {string}
 */
function serviceName(service) {
  if (service.name) {
    return service.name;
  }
  // Названия услуг в панели берём из русских подписей словаря и не
  // переводим: админка существует только на русском, а i18n здесь нужен
  // как источник текста. Обращение именно к ru, а не к текущему языку —
  // если владелец открыл панель после армянской версии сайта, названия
  // услуг всё равно должны быть понятны (см. getBaseText ниже).
  const key = `services.${service.id}.name`;
  const label = i18n.getBaseText('ru', key);
  return label || service.id;
}

/**
 * Услуга добавлена в админке? У таких нет ключа перевода, поэтому
 * армянская версия сайта покажет русское название — это надо подсветить.
 *
 * @param {string} id Идентификатор.
 * @returns {boolean} true, если id нет в базовом конфиге.
 */
function isCustomService(id) {
  return !(CONFIG.pricing.services || []).some((service) => service.id === id);
}

/**
 * Перерисовывает таблицу услуг.
 *
 * @returns {void}
 */
function renderServices() {
  const body = $('[data-services-body]');
  if (!body) {
    return;
  }
  const services = [...(content.pricing.services || [])].sort(
    (a, b) => (a.order || 0) - (b.order || 0)
  );
  body.textContent = '';

  if (!services.length) {
    const tr = el('tr');
    const td = el('td', { colspan: '5' });
    td.appendChild(el('p', {
      class: 'admin-empty',
      text: 'Услуг пока нет. Добавьте первую формой ниже.',
    }));
    tr.appendChild(td);
    body.appendChild(tr);
  } else {
    services.forEach((service, index) => {
      const id = String(service.id);
      const name = serviceName(service);

      // ── Название
      // Услугу из config.js переименовать отсюда нельзя: её название лежит
      // в словарях (ru.js / hy.js) отдельно для каждого языка, и запись
      // service.name затёрла бы сразу оба языка. Показываем как есть и
      // подсказываем, где менять; переименование доступно только услугам,
      // добавленным в админке, — у них кроме поля name названия нет.
      const nameWrap = el('div');
      const custom = isCustomService(id);
      if (custom) {
        nameWrap.appendChild(el('input', {
          class: 'admin-input',
          type: 'text',
          value: name,
          maxlength: '80',
          'data-service-name': id,
          'aria-label': `Название услуги «${name}»`,
        }));
      } else {
        nameWrap.appendChild(el('p', {
          class: 'admin-svc__name',
          text: name,
        }));
      }
      nameWrap.appendChild(el('span', { class: 'admin-svc__id', text: id }));
      if (custom) {
        nameWrap.appendChild(el('span', { class: 'admin-tag', text: 'новая' }));
      }

      // ── Цена
      const priceWrap = el('div', { class: 'admin-price-cell' });
      priceWrap.appendChild(el('input', {
        class: 'admin-input',
        type: 'number',
        min: '0',
        step: '100',
        value: String(Number(service.basePrice) || 0),
        'data-service-price': id,
        'aria-label': `Базовая цена услуги «${name}»`,
      }));
      priceWrap.appendChild(el('span', { class: 'admin-price-cell__cur', text: '₽' }));

      // ── Класс
      const scaleBox = el('input', {
        type: 'checkbox',
        'data-service-scale': id,
        'aria-label': `Цена зависит от класса автомобиля: «${name}»`,
      });
      if (service.scaleByClass !== false) {
        scaleBox.setAttribute('checked', '');
      }
      const scaleLabel = el('label', { class: 'admin-field--check' });
      scaleLabel.appendChild(scaleBox);
      scaleLabel.appendChild(el('span', { text: 'да' }));

      // ── Действия
      const actions = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
      const up = el('button', {
        type: 'button',
        class: 'admin-btn admin-btn--mini',
        'data-move-service': id,
        'data-dir': '-1',
        'aria-label': `Поднять «${name}» выше`,
      }, ['↑']);
      const down = el('button', {
        type: 'button',
        class: 'admin-btn admin-btn--mini',
        'data-move-service': id,
        'data-dir': '1',
        'aria-label': `Опустить «${name}» ниже`,
      }, ['↓']);
      // Крайние кнопки гасим, а не скрываем: так строка не «прыгает»
      // по ширине при прокрутке списка.
      if (index === 0) {
        up.setAttribute('disabled', '');
      }
      if (index === services.length - 1) {
        down.setAttribute('disabled', '');
      }
      actions.appendChild(up);
      actions.appendChild(down);
      actions.appendChild(el('button', {
        type: 'button',
        class: 'admin-btn admin-btn--mini is-danger',
        'data-delete-service': id,
        'aria-label': `Удалить услугу «${name}»`,
      }, ['Удалить']));

      // ── Фоновое фото карточки
      //
      // Путь текстом ИЛИ файл из проводника — по той же логике, что в
      // разделе «Фотографии»: у файла нет «значения», читаемого из общего
      // поля, поэтому у каждой строки свой скрытый input.
      const imageWrap = el('div', { class: 'admin-svc__image' });
      const imageValue = String(service.image || '');
      const imageThumb = el('div', { class: 'admin-svc__thumb' });
      if (imageValue && imageValue.indexOf('[ЗАПОЛНИТЬ]') === -1) {
        // alt пустой: это превью выбранного фона, а не содержательная
        // картинка — скринридеру оно ничего не добавляет.
        imageThumb.appendChild(el('img', { src: imageValue, alt: '' }));
      } else {
        imageThumb.appendChild(el('span', { class: 'admin-svc__thumb-empty', text: 'нет' }));
      }
      const imageInput = el('input', {
        class: 'admin-input',
        type: 'text',
        value: imageValue.indexOf('[ЗАПОЛНИТЬ]') === -1 ? imageValue : '',
        placeholder: 'assets/gallery/photo-1.jpg',
        'data-service-image': id,
        'aria-label': `Путь к фоновому фото услуги «${name}»`,
      });
      const imageRow = el('div', { class: 'admin-svc__image-row' });
      imageRow.appendChild(el('button', {
        type: 'button',
        class: 'admin-btn admin-btn--mini',
        'data-service-image-file': id,
        'aria-label': `Выбрать файл фона для услуги «${name}»`,
      }, ['Файл']));
      if (imageValue) {
        imageRow.appendChild(el('button', {
          type: 'button',
          class: 'admin-btn admin-btn--mini is-danger',
          'data-service-image-clear': id,
          'aria-label': `Убрать фон услуги «${name}»`,
        }, ['×']));
      }
      imageWrap.appendChild(imageThumb);
      imageWrap.appendChild(imageInput);
      imageWrap.appendChild(imageRow);
      imageWrap.appendChild(el('input', {
        type: 'file',
        accept: 'image/*',
        'data-service-image-input': id,
        hidden: '',
      }));

      body.appendChild(el('tr', { 'data-service-row': id }, [
        el('td', { class: 'admin-table__cellnum', text: String(index + 1).padStart(2, '0') }),
        el('td', {}, [nameWrap]),
        el('td', {}, [imageWrap]),
        el('td', {}, [priceWrap]),
        el('td', {}, [scaleLabel]),
        el('td', {}, [actions]),
      ]));
    });
  }

  const modeBox = $('[data-price-mode]');
  if (modeBox) {
    modeBox.checked = content.pricing.priceMode === 'fixed';
  }
}

/**
 * Переносит состав услуг из content в черновик дельты.
 *
 * name/desc сохраняются только у услуг из админки: у заводских они
 * берутся из словарей, и дублировать их в дельте незачем — иначе
 * правка перевода на сайте больше не подхватилась бы.
 *
 * @returns {void}
 */
function persistServices() {
  draft.services = (content.pricing.services || []).map((service) => {
    const item = {
      id: service.id,
      basePrice: service.basePrice,
      scaleByClass: service.scaleByClass !== false,
      order: service.order,
    };
    if (service.name) {
      item.name = service.name;
    }
    if (service.desc) {
      item.desc = service.desc;
    }
    // Путь к фоновому фото. Пустая строка — законное значение «фона нет»,
    // и оно обязано пережить сохранение: иначе снять фото было бы нельзя,
    // потому что ключ просто исчезал бы из дельты.
    if (typeof service.image === 'string') {
      item.image = service.image;
    }
    return item;
  });
  // Цены теперь живут внутри services. Отдельный патч prices, оставшийся
  // от прошлой версии, удаляем: два источника одной величины разошлись бы.
  delete draft.prices;
}

/**
 * Записывает путь к фоновому фото услуги и сохраняет.
 *
 * @param {string} id Идентификатор услуги.
 * @param {string} value Путь к картинке.
 * @returns {void}
 */
function setServiceImage(id, value) {
  const service = (content.pricing.services || []).find((item) => item.id === id);
  if (!service) {
    return;
  }
  service.image = String(value || '').trim();
  persistServices();
  commit('Фото услуги сохранено');
}

/**
 * Убирает фоновое фото услуги.
 *
 * @param {string} id Идентификатор услуги.
 * @returns {void}
 */
function clearServiceImage(id) {
  setServiceImage(id, '');
}

/**
 * Читает выбранный файл как data URL и ставит его фоном услуги.
 *
 * Лимит ниже, чем у галереи (там 700 КБ), и по той же причине: localStorage
 * даёт около 5 МБ, а base64 раздувает файл на треть. Девять фонов по 700 КБ
 * в квоту уже не влезут, поэтому порог для карточек ниже — иначе заказчик
 * заполнит все девять и потеряет последние правки молча.
 *
 * @param {string} id Идентификатор услуги.
 * @param {File} file Файл из input.
 * @returns {void}
 */
function readServiceImageFile(id, file) {
  if (!file) {
    return;
  }
  if (file.size > 300 * 1024) {
    toast(
      `Файл ${Math.round(file.size / 1024)} КБ — слишком большой: девять таких фонов `
      + 'не поместятся в память браузера. Уменьшите фото или положите его '
      + 'в assets/gallery/ и укажите путь текстом.',
      'err'
    );
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    setServiceImage(id, String(reader.result || ''));
  };
  reader.onerror = () => toast('Не удалось прочитать файл', 'err');
  reader.readAsDataURL(file);
}

/**
 * Переиндексирует order по текущему порядку массива, чтобы после
 * удаления и перестановки не осталось дыр (1,2,5,7).
 *
 * @param {Array<Object>} services Список услуг.
 * @returns {void}
 */
function reindex(services) {
  services.forEach((service, index) => {
    service.order = index + 1;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ПРАЙС-ЛИСТ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Все id услуг, уже разложенные по разделам прайса.
 *
 * @param {Object} pricelist Данные прайса.
 * @returns {Set<string>} Использованные id.
 */
function usedServiceIds(pricelist) {
  const used = new Set();
  (pricelist.groups || []).forEach((group) => {
    (group.services || []).forEach((id) => used.add(String(id)));
  });
  return used;
}

/**
 * Перерисовывает разделы прайса.
 *
 * @returns {void}
 */
function renderGroups() {
  const container = $('[data-groups]');
  if (!container) {
    return;
  }
  const pricelist = content.pricelist || {};
  const groups = pricelist.groups || [];
  const services = content.pricing.services || [];
  const byId = new Map(services.map((service) => [String(service.id), service]));
  const used = usedServiceIds(pricelist);

  container.textContent = '';

  if (!groups.length) {
    container.appendChild(el('p', {
      class: 'admin-empty',
      text: 'Разделов нет. Все услуги попадут в прайс одним блоком.',
    }));
  }

  groups.forEach((group) => {
    const ids = group.services || [];
    const card = el('div', { class: 'admin-group', 'data-group': group.id });

    // ── Заголовок раздела
    const head = el('div', { class: 'admin-group__head' });
    head.appendChild(el('input', {
      class: 'admin-input',
      type: 'text',
      value: group.title || '',
      maxlength: '60',
      'data-group-title': group.id,
      'aria-label': 'Название раздела прайса',
    }));
    head.appendChild(el('span', {
      class: 'admin-group__count',
      text: `${ids.length} усл.`,
    }));
    head.appendChild(el('button', {
      type: 'button',
      class: 'admin-btn admin-btn--mini is-danger',
      'data-delete-group': group.id,
    }, ['Удалить раздел']));
    card.appendChild(head);

    // ── Строки раздела
    const list = el('ul', { class: 'admin-chips' });
    ids.forEach((id, index) => {
      const service = byId.get(String(id));
      if (!service) {
        // Услугу удалили, а id остался в разделе: показываем это явно,
        // иначе раздел молча потеряет строку без объяснения.
        const orphan = el('li', { class: 'admin-chip' });
        orphan.appendChild(el('span', {
          class: 'admin-chip__name',
          text: `${id} — услуга удалена`,
        }));
        orphan.appendChild(el('button', {
          type: 'button',
          class: 'admin-btn admin-btn--mini is-danger',
          'data-remove-chip': id,
          'data-group': group.id,
        }, ['×']));
        list.appendChild(orphan);
        return;
      }

      const chip = el('li', { class: 'admin-chip', 'data-chip': id });
      chip.appendChild(el('span', {
        class: 'admin-chip__handle',
        text: '⋮⋮',
        'aria-hidden': 'true',
      }));
      chip.appendChild(el('span', { class: 'admin-chip__name', text: serviceName(service) }));
      chip.appendChild(el('span', { class: 'admin-chip__id', text: id }));

      const order = el('span', { class: 'admin-chip__order' });
      const up = el('button', {
        type: 'button',
        class: 'admin-btn admin-btn--mini',
        'data-move-chip': id,
        'data-group': group.id,
        'data-dir': '-1',
        'aria-label': 'Выше',
      }, ['↑']);
      const down = el('button', {
        type: 'button',
        class: 'admin-btn admin-btn--mini',
        'data-move-chip': id,
        'data-group': group.id,
        'data-dir': '1',
        'aria-label': 'Ниже',
      }, ['↓']);
      if (index === 0) {
        up.setAttribute('disabled', '');
      }
      if (index === ids.length - 1) {
        down.setAttribute('disabled', '');
      }
      order.appendChild(up);
      order.appendChild(down);
      order.appendChild(el('button', {
        type: 'button',
        class: 'admin-btn admin-btn--mini is-danger',
        'data-remove-chip': id,
        'data-group': group.id,
        'aria-label': `Убрать «${serviceName(service)}» из раздела`,
      }, ['×']));
      chip.appendChild(order);
      list.appendChild(chip);
    });

    if (!ids.length) {
      list.appendChild(el('li', {
        class: 'admin-chip__id',
        text: 'Раздел пуст — добавьте услугу ниже.',
        style: 'padding:8px 4px',
      }));
    }
    card.appendChild(list);

    // ── Добавление услуги в раздел: предлагаем только те, которых
    // в прайсе ещё нет. Уже разложенная услуга в списке не появится:
    // дубль строки в прайсе читался бы как две разные услуги.
    const available = services.filter((service) => !used.has(String(service.id)));
    if (available.length) {
      const addRow = el('div', { class: 'admin-group__add' });
      const select = el('select', {
        class: 'admin-select',
        'data-add-chip-select': group.id,
        'aria-label': `Услуга для добавления в раздел ${group.title || group.id}`,
      });
      available.forEach((service) => {
        select.appendChild(el('option', { value: service.id, text: serviceName(service) }));
      });
      addRow.appendChild(select);
      addRow.appendChild(el('button', {
        type: 'button',
        class: 'admin-btn admin-btn--mini',
        'data-add-chip': group.id,
      }, ['Добавить в раздел']));
      card.appendChild(addRow);
    }

    container.appendChild(card);
  });

  // ── Тексты под прайсом
  // note может быть строкой (старый формат) или объектом {ru, hy}.
  // Форма показывает один язык за раз — тот, что выбран в noteLang.
  const textsForm = $('[data-pricelist-texts]');
  const noteField = $('[data-pricelist-texts] [name="note"]');
  const noteLangField = $('[data-pricelist-texts] [name="noteLang"]');
  if (noteField && noteLangField) {
    const lang = noteLangField.value || 'ru';
    noteField.value = noteText(pricelist.note, lang);
    if (!textsForm || textsForm.getAttribute('data-note-bound') !== 'true') {
      if (textsForm) {
        textsForm.setAttribute('data-note-bound', 'true');
        on(noteLangField, 'change', () => {
          const next = noteLangField.value || 'ru';
          noteField.value = noteText(content.pricelist.note, next);
        });
      }
    }
  }
  const updatedField = $('[data-pricelist-texts] [name="updated"]');
  if (updatedField) {
    updatedField.value = pricelist.updated || '';
  }
}

/**
 * Достаёт примечание для конкретного языка из любой поддерживаемой формы.
 *
 * @param {string|Object|undefined} note
 * @param {'ru'|'hy'} lang
 * @returns {string}
 */
function noteText(note, lang) {
  if (typeof note === 'string') {
    return note;
  }
  if (note && typeof note === 'object' && typeof note[lang] === 'string') {
    return note[lang];
  }
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// ФОТОГРАФИИ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Плитки галереи в том виде, в каком их ждёт сайт.
 *
 * Пустая строка src означает «заглушка»: именно так выглядит сайт сейчас,
 * пока заказчик не дал фотографии. Сохранять этот случай отдельным флагом
 * незачем — путь и есть флаг.
 *
 * @returns {Array<{src: string}>} Список плиток.
 */
function galleryItems() {
  const fromConfig = (CONFIG.gallery && CONFIG.gallery.items) || [];
  if (!fromConfig.length) {
    // Базового списка нет — берём столько плиток, сколько в разметке сайта.
    // Шесть совпадает с index.html; если разметку изменят, лишние плитки
    // просто не покажутся, а недостающие не появятся.
    return Array.from({ length: 6 }, () => ({ src: '' }));
  }
  return fromConfig.map((item) => ({ src: item.src || '' }));
}

/**
 * Перерисовывает сетку фотографий.
 *
 * @returns {void}
 */
function renderPhotos() {
  const container = $('[data-photos]');
  if (!container) {
    return;
  }
  const items = (content.gallery && content.gallery.items) || galleryItems();
  container.textContent = '';

  items.forEach((item, index) => {
    const thumb = el('div', { class: 'admin-photo__thumb' });
    thumb.appendChild(el('span', {
      class: 'admin-photo__num',
      text: String(index + 1).padStart(2, '0'),
    }));
    if (item.src) {
      // onerror не вешаем: битая ссылка должна быть видна как битая,
      // иначе заказчик будет искать ошибку в админке, а не в пути.
      thumb.appendChild(el('img', { src: item.src, alt: `Работа ${index + 1}`, loading: 'lazy' }));
    } else {
      thumb.appendChild(el('span', {
        class: 'admin-photo__empty',
        text: 'Фотографии нет — на сайте будет premium-заглушка',
      }));
    }

    const srcInput = el('input', {
      class: 'admin-input',
      type: 'text',
      value: item.src || '',
      'data-photo-src': String(index),
      'aria-label': `Путь к фото ${index + 1}`,
      placeholder: `assets/gallery/photo-${index + 1}.jpg`,
    });

    const row = el('div', { class: 'admin-photo__row' });
    row.appendChild(el('button', {
      type: 'button',
      class: 'admin-btn admin-btn--mini',
      'data-photo-up': String(index),
      'aria-label': 'Левее',
    }, ['←']));
    row.appendChild(el('button', {
      type: 'button',
      class: 'admin-btn admin-btn--mini',
      'data-photo-down': String(index),
      'aria-label': 'Правее',
    }, ['→']));
    row.appendChild(el('button', {
      type: 'button',
      class: 'admin-btn admin-btn--mini',
      'data-photo-file': String(index),
      'aria-label': 'Выбрать файл',
    }, ['Файл']));
    row.appendChild(el('button', {
      type: 'button',
      class: 'admin-btn admin-btn--mini is-danger',
      'data-photo-delete': String(index),
      'aria-label': 'Удалить плитку',
    }, ['×']));

    // Скрытый input на каждую плитку: у файла нет «значения», которое
    // можно прочитать из общего поля, поэтому нужен свой обработчик.
    const file = el('input', {
      type: 'file',
      accept: 'image/*',
      'data-photo-file-input': String(index),
      hidden: '',
    });

    const body = el('div', { class: 'admin-photo__body' });
    body.appendChild(srcInput);
    body.appendChild(row);
    body.appendChild(file);

    container.appendChild(el('div', { class: 'admin-photo', 'data-photo': String(index) }, [
      thumb,
      body,
    ]));
  });
}

/**
 * Читает выбранный файл как data URL и кладёт в плитку.
 *
 * ⚠️ В localStorage хранится строка, а квота браузера — около 5 МБ.
 * Фото с телефона весит 2–4 МБ, и одно такое изображение в base64
 * раздувается на треть. Поэтому файл разрешаем, но честно предупреждаем
 * о лимите: молча упасть на сохранении было бы хуже.
 *
 * @param {number} index Индекс плитки.
 * @param {File} file Файл из input.
 * @returns {void}
 */
function readPhotoFile(index, file) {
  if (!file) {
    return;
  }
  if (file.size > 700 * 1024) {
    toast(
      `Файл ${Math.round(file.size / 1024)} КБ — слишком большой для браузерного хранилища. `
      + 'Положите его в assets/gallery/ и укажите путь текстом.',
      'err'
    );
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const items = (content.gallery && content.gallery.items) || galleryItems();
    items[index] = { src: String(reader.result || '') };
    content.gallery = { items };
    draft.gallery = { items: items.map((item) => ({ src: item.src || '' })) };
    commit('Фото добавлено');
  };
  reader.onerror = () => toast('Не удалось прочитать файл', 'err');
  reader.readAsDataURL(file);
}

// ─────────────────────────────────────────────────────────────────────────────
// ТЕКСТЫ САЙТА
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Подписи разделов сайта. Порядок намеренный: сначала то, что видит
 * посетитель при заходе, потом правовые документы. Совпадает с порядком
 * блоков на странице, чтобы искать было интуитивно.
 *
 * @type {Array<{id: string, label: string}>}
 */
const TEXT_GROUPS = [
  { id: 'meta', label: 'Метаданные и SEO' },
  { id: 'nav', label: 'Меню и навигация' },
  { id: 'hero', label: 'Первый экран' },
  { id: 'services', label: 'Услуги' },
  { id: 'pricing', label: 'Прайс-лист' },
  { id: 'calc', label: 'Калькулятор VIN' },
  { id: 'gallery', label: 'Галерея работ' },
  { id: 'adv', label: 'Преимущества' },
  { id: 'form', label: 'Форма заявки' },
  { id: 'contacts', label: 'Контакты' },
  { id: 'footer', label: 'Подвал' },
  { id: 'cookie', label: 'Cookie-баннер' },
  { id: 'social', label: 'Соцсети' },
  { id: 'legal', label: 'Юридические документы' },
];

/**
 * Человеческое название языка — для бейджей и сообщений.
 *
 * @param {string} lang Код языка.
 * @returns {string} Подпись.
 */
function langLabel(lang) {
  return lang === 'hy' ? 'Армянский' : 'Русский';
}

/**
 * Определяет раздел сайта по ключу перевода.
 *
 * Ключи вида 'services.ppf.name' и 'legal.privacyRu.s1.p1' дают
 * 'services' и 'legal'. Всё, что не совпало с известным префиксом,
 * попадает в «прочее» — так новый ключ не потеряется молча.
 *
 * @param {string} key Ключ перевода.
 * @returns {string} Идентификатор раздела.
 */
function groupOf(key) {
  const prefix = String(key).split('.')[0];
  return TEXT_GROUPS.some((group) => group.id === prefix) ? prefix : 'other';
}

/**
 * Подпись раздела по его идентификатору.
 *
 * @param {string} id Идентификатор.
 * @returns {string} Подпись.
 */
function groupLabel(id) {
  const found = TEXT_GROUPS.find((group) => group.id === id);
  return found ? found.label : 'Прочее';
}

/** @type {string} Язык, который сейчас редактируется в разделе «Тексты». */
let textsLang = 'ru';

/** @type {string} Текущий поисковый запрос. */
let textsQuery = '';

/** @type {string} Выбранный раздел ('' — все). */
let textsGroup = '';

/** @type {boolean} Показывать только изменённые строки. */
let textsOnlyChanged = false;

/**
 * Сколько строк текста рисуется за один раз.
 *
 * 429 textarea — это 429 полей с собственным состоянием и обработчиком
 * ввода; браузер справляется, но ввод начинает подтормаживать на слабых
 * машинах. Порог в 120 строк держит панель отзывчивой, а поиск всё равно
 * сужает список до нескольких строк за одно слово. Число не «магическое»:
 * это примерно два экрана прокрутки.
 */
const TEXTS_RENDER_LIMIT = 120;

/**
 * Задержка сохранения текста после последнего нажатия клавиши, мс.
 *
 * 900 мс — компромисс: быстрее — и на каждой паузе между словами в GitHub
 * уходил бы отдельный коммит; медленнее — заказчик успевает закрыть
 * вкладку и потерять правку. Уход фокуса сохраняет немедленно, поэтому
 * таймер срабатывает только если человек продолжает печатать.
 */
const TEXTS_SAVE_DELAY = 900;

/** @type {number} Таймер отложенного сохранения текста. */
let textsSaveTimer = 0;

/**
 * Собирает плоский список строк словаря для отрисовки.
 *
 * Ключи берутся из русского словаря: он источник истины по составу.
 * Если в армянском ключа нет, строка всё равно попадает в список — с
 * пометкой «нет перевода», чтобы дырку было видно и можно было закрыть
 * прямо здесь, не заходя в код.
 *
 * @returns {Array<{key: string, group: string, base: string, current: string, changed: boolean, missing: boolean}>}
 */
function collectTextRows() {
  const all = i18n.allKeys();
  const missingHy = new Set(i18n.missingIn('hy'));
  return all.map((key) => {
    const base = i18n.getBaseText(textsLang, key);
    const override = i18n.getOverride(textsLang, key);
    return {
      key,
      group: groupOf(key),
      base,
      current: override !== '' ? override : base,
      changed: override !== '',
      missing: textsLang === 'hy' && missingHy.has(key),
    };
  });
}

/**
 * Фильтрует строки по запросу, разделу и флагу «только изменённые».
 *
 * @param {Array<Object>} rows Все строки.
 * @returns {Array<Object>} Отфильтрованные.
 */
function filterTextRows(rows) {
  const query = textsQuery.trim().toLowerCase();
  return rows.filter((row) => {
    if (textsOnlyChanged && !row.changed) {
      return false;
    }
    if (textsGroup && row.group !== textsGroup) {
      return false;
    }
    if (!query) {
      return true;
    }
    // Ищем и по ключу, и по тексту на обоих языках: заказчик помнит,
    // что написано на сайте, а не как называется переменная.
    const ruText = i18n.getText('ru', row.key).toLowerCase();
    const hyText = i18n.getText('hy', row.key).toLowerCase();
    return row.key.toLowerCase().includes(query)
      || ruText.includes(query)
      || hyText.includes(query);
  });
}

/**
 * Разбирает подстановки вида {city} в строке.
 *
 * @param {string} value Текст.
 * @returns {string[]} Имена подстановок в порядке появления.
 */
function extractPlaceholders(value) {
  const found = [];
  String(value).replace(/\{(\w+)\}/g, (match, name) => {
    if (!found.includes(name)) {
      found.push(name);
    }
    return match;
  });
  return found;
}

/**
 * Подсвечивает в поле подстановки, которые были в исходном тексте, но
 * пропали из текущего.
 *
 * Полноценный подсветить-внутри-textarea без отдельного слоя разметки не
 * сделать, поэтому сигнал простой и честный: рамка поля краснеет, а в
 * подсказке под полем появляется «потеряно: {city}». Заказчик видит, что
 * именно сломалось, и не публикует текст с дыркой.
 *
 * @param {HTMLTextAreaElement} field Поле ввода.
 * @param {string} key Ключ перевода.
 * @returns {void}
 */
function markLostPlaceholders(field, key) {
  const expected = extractPlaceholders(i18n.getBaseText(textsLang, key));
  const present = extractPlaceholders(field.value);
  const lost = expected.filter((name) => !present.includes(name));

  if (lost.length) {
    field.classList.add('is-invalid');
  } else {
    field.classList.remove('is-invalid');
  }

  const card = field.closest('.admin-text-row');
  if (!card) {
    return;
  }
  const hint = card.querySelector('.admin-text-row__hint');
  if (!hint) {
    return;
  }
  const existing = hint.querySelector('[data-tone="missing"]');
  if (lost.length && !existing) {
    hint.appendChild(el('span', {
      class: 'admin-text-row__badge',
      'data-tone': 'missing',
      text: `потеряно: ${lost.map((name) => `{${name}}`).join(', ')}`,
    }));
  } else if (!lost.length && existing) {
    existing.remove();
  }
}

/**
 * Перерисовывает список текстов целиком.
 *
 * Перерисовка целиком, а не точечное обновление строки: фильтры зависят
 * от содержимого полей («только изменённые», поиск), и обновлять одну
 * строку значило бы оставлять список в состоянии, не соответствующем
 * текущему фильтру.
 *
 * Список из 429 полей не рисуется целиком ни при каких условиях: браузер
 * создал бы 429 textarea за один кадр, и ввод начал бы подтормаживать.
 * Поэтому действует порог TEXTS_RENDER_LIMIT, а в подсказке честно
 * написано, сколько строк осталось за его пределами.
 *
 * @returns {void}
 */
function renderTexts() {
  const list = $('[data-texts-list]');
  const empty = $('[data-texts-empty]');
  const stats = $('[data-texts-stats]');
  if (!list) {
    return;
  }

  const all = collectTextRows();
  const rows = filterTextRows(all);
  const changedTotal = all.filter((row) => row.changed).length;
  const missingTotal = textsLang === 'hy'
    ? all.filter((row) => row.missing).length
    : 0;
  const shown = rows.slice(0, TEXTS_RENDER_LIMIT);

  if (stats) {
    const parts = [
      `Показано ${shown.length} из ${all.length}`,
      `изменено: ${changedTotal}`,
    ];
    if (textsLang === 'hy') {
      parts.push(missingTotal ? `нет перевода: ${missingTotal}` : 'перевод полный');
    }
    if (rows.length > shown.length) {
      parts.push(`уточните поиск, чтобы увидеть остальные ${rows.length - shown.length}`);
    }
    setText(stats, parts.join(' · '));
  }

  if (empty) {
    if (rows.length) {
      empty.setAttribute('hidden', '');
    } else {
      empty.removeAttribute('hidden');
    }
  }

  // Собираем разметку вне DOM и вставляем одним движением: так браузер
  // пересчитывает стили один раз, а не после каждого узла.
  const fragment = document.createDocumentFragment();

  shown.forEach((row) => {
    const card = el('div', {
      class: 'admin-text-row',
      'data-text-row': row.key,
      'data-changed': row.changed ? '1' : '0',
    });

    const head = el('div', { class: 'admin-text-row__head' });
    head.appendChild(el('span', { class: 'admin-text-row__key', text: row.key }));

    const badges = el('div', { class: 'admin-text-row__badges' });
    badges.appendChild(el('span', {
      class: 'admin-text-row__badge',
      text: groupLabel(row.group),
    }));
    if (row.missing) {
      badges.appendChild(el('span', {
        class: 'admin-text-row__badge',
        'data-tone': 'missing',
        text: 'нет перевода',
      }));
    }
    if (row.changed) {
      badges.appendChild(el('span', {
        class: 'admin-text-row__badge',
        'data-tone': 'changed',
        text: 'изменено',
      }));
    }
    head.appendChild(badges);
    card.appendChild(head);

    const input = el('textarea', {
      class: 'admin-input admin-text-row__area',
      'data-text-input': row.key,
      'data-lang': textsLang,
      rows: '3',
      spellcheck: 'true',
    });
    input.value = row.current;
    card.appendChild(input);

    // Подстановки. Проверяем, что все исходные на месте: если заказчик
    // стёр {city}, на сайте в этом месте будет пусто или «{city}».
    const expected = extractPlaceholders(row.base);
    const present = extractPlaceholders(row.current);
    const lost = expected.filter((name) => !present.includes(name));

    const foot = el('div', { class: 'admin-text-row__foot' });
    const hint = el('div', { class: 'admin-text-row__hint' });
    if (expected.length) {
      setText(hint, `Подстановки: ${expected.join(', ')}`);
      if (lost.length) {
        hint.appendChild(el('span', {
          class: 'admin-text-row__badge',
          'data-tone': 'missing',
          text: `потеряно: ${lost.map((name) => `{${name}}`).join(', ')}`,
        }));
      }
    } else {
      setText(hint, 'Без подстановок');
    }
    foot.appendChild(hint);

    const reset = el('button', {
      type: 'button',
      class: 'admin-text-row__reset',
      'data-action': 'reset-text',
      'data-key': row.key,
      text: 'Вернуть исходный',
    });
    if (!row.changed) {
      reset.setAttribute('disabled', '');
    }
    foot.appendChild(reset);
    card.appendChild(foot);

    // Исходный текст показываем всегда, когда он отличается от текущего:
    // это единственный способ увидеть, что именно было до правки.
    if (row.changed) {
      const base = el('span', { class: 'admin-text-row__base' });
      base.appendChild(el('b', { text: 'Было: ' }));
      base.appendChild(document.createTextNode(row.base || '(пусто)'));
      card.appendChild(base);
    }

    fragment.appendChild(card);
  });

  list.replaceChildren(fragment);
}

/**
 * Сохраняет правку одной строки, не перерисовывая список.
 *
 * Перерисовка здесь была бы вредна: пользователь продолжает печатать в
 * том же поле, и замена узла textarea отняла бы у него фокус и каретку.
 * Поэтому обновляем только бейдж и кнопку «Вернуть исходный» у этой
 * строки, а полный renderTexts() вызывается позже и только если нужно.
 *
 * Пустое значение и значение, совпадающее с исходным, одинаково означают
 * «вернуть как было»: хранить копию словаря незачем, а «изменено» должно
 * сниматься само, когда заказчик вернул текст вручную.
 *
 * @param {string} key Ключ перевода.
 * @param {string} value Новый текст.
 * @returns {boolean} true, если что-то действительно изменилось.
 */
function saveTextOverride(key, value) {
  const overrides = i18n.readTextOverrides();
  const base = i18n.getBaseText(textsLang, key);
  const bucket = { ...overrides[textsLang] };
  const before = bucket[key];

  if (!value.trim() || value === base) {
    if (!Object.prototype.hasOwnProperty.call(bucket, key)) {
      return false;
    }
    delete bucket[key];
  } else {
    if (bucket[key] === value) {
      return false;
    }
    bucket[key] = value;
  }

  overrides[textsLang] = bucket;
  // Пишем через i18n: он и в хранилище кладёт, и на странице применяет,
  // и локальное состояние обновляет — три вещи, которые легко развести
  // по трём местам и потом забыть одну.
  i18n.writeTextOverrides(overrides);
  updateTextRowState(key);
  return true;
}

/**
 * Обновляет бейджи и состояние кнопки у одной строки — без перерисовки поля.
 *
 * @param {string} key Ключ перевода.
 * @returns {void}
 */
function updateTextRowState(key) {
  const card = document.querySelector(`[data-text-row="${CSS.escape(key)}"]`);
  if (!card) {
    return;
  }
  const changed = i18n.getOverride(textsLang, key) !== '';
  card.setAttribute('data-changed', changed ? '1' : '0');

  const badges = card.querySelector('.admin-text-row__badges');
  const existing = badges ? badges.querySelector('[data-tone="changed"]') : null;
  if (changed && badges && !existing) {
    badges.appendChild(el('span', {
      class: 'admin-text-row__badge',
      'data-tone': 'changed',
      text: 'изменено',
    }));
  } else if (!changed && existing) {
    existing.remove();
  }

  const reset = card.querySelector('[data-action="reset-text"]');
  if (reset) {
    if (changed) {
      reset.removeAttribute('disabled');
    } else {
      reset.setAttribute('disabled', '');
    }
  }

  // Блок «Было: …» появляется и исчезает вместе с признаком правки.
  const baseBlock = card.querySelector('.admin-text-row__base');
  if (changed && !baseBlock) {
    const base = el('span', { class: 'admin-text-row__base' });
    base.appendChild(el('b', { text: 'Было: ' }));
    base.appendChild(document.createTextNode(i18n.getBaseText(textsLang, key) || '(пусто)'));
    card.appendChild(base);
  } else if (!changed && baseBlock) {
    baseBlock.remove();
  }

  updateTextsStats();
}

/**
 * Обновляет только строку статистики — дешевле, чем перерисовка списка.
 *
 * @returns {void}
 */
function updateTextsStats() {
  const stats = $('[data-texts-stats]');
  if (!stats) {
    return;
  }
  const all = collectTextRows();
  const changedTotal = all.filter((row) => row.changed).length;
  const missingTotal = textsLang === 'hy'
    ? all.filter((row) => row.missing).length
    : 0;
  const parts = [`всего строк: ${all.length}`, `изменено: ${changedTotal}`];
  if (textsLang === 'hy') {
    parts.push(missingTotal ? `нет перевода: ${missingTotal}` : 'перевод полный');
  }
  setText(stats, parts.join(' · '));
}

/**
 * Возвращает одну строку к исходному тексту из словаря.
 *
 * @param {string} key Ключ перевода.
 * @returns {void}
 */
function resetTextOverride(key) {
  const overrides = i18n.readTextOverrides();
  if (!Object.prototype.hasOwnProperty.call(overrides[textsLang], key)) {
    return;
  }
  delete overrides[textsLang][key];
  i18n.writeTextOverrides(overrides);
  const input = document.querySelector(`[data-text-input="${CSS.escape(key)}"]`);
  if (input) {
    input.value = i18n.getBaseText(textsLang, key);
  }
  updateTextRowState(key);
  commit('Текст возвращён к исходному');
}

/**
 * Сбрасывает ВСЕ правки текстов на текущем языке.
 *
 * Подтверждение обязательно: в отличие от одной строки, здесь можно
 * потерять часы работы над армянской вычиткой.
 *
 * @returns {void}
 */
function clearAllTexts() {
  const rows = collectTextRows().filter((row) => row.changed);
  if (!rows.length) {
    toast('Изменённых текстов нет', 'err');
    return;
  }
  const confirmed = window.confirm(
    `Вернуть к исходному все ${rows.length} изменённых текстов на языке `
    + `«${langLabel(textsLang)}»?\n\nЭто действие нельзя отменить.`
  );
  if (!confirmed) {
    return;
  }
  const overrides = i18n.readTextOverrides();
  overrides[textsLang] = {};
  i18n.writeTextOverrides(overrides);
  commit('Все тексты возвращены к исходным');
}

/**
 * Заполняет выпадающий список разделов один раз при старте.
 *
 * @returns {void}
 */
function initTextsFilters() {
  const select = $('[data-texts-group]');
  if (!select || select.options.length > 1) {
    return;
  }
  TEXT_GROUPS.forEach((group) => {
    const option = el('option', { value: group.id, text: group.label });
    select.appendChild(option);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ФИЛИАЛЫ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Перерисовывает карточки филиалов.
 *
 * @returns {void}
 */
function renderBranches() {
  const container = $('[data-branches]');
  if (!container) {
    return;
  }
  const branches = content.branches || {};
  const ids = Object.keys(branches);
  container.textContent = '';

  ids.forEach((id, index) => {
    const branch = branches[id];
    const isPrimary = id === content.primaryBranch;
    const isBare = branch.isBranch === false;

    const card = el('div', {
      class: `admin-branch${isPrimary ? ' is-primary' : ''}`,
      'data-branch': id,
    });

    // ── Заголовок карточки
    const head = el('div', { class: 'admin-branch__head' });
    const titleWrap = el('div');
    const title = el('h2', { class: 'admin-branch__title', text: branch.city || id });
    titleWrap.appendChild(title);
    if (isPrimary) {
      titleWrap.appendChild(el('span', { class: 'admin-branch__badge', text: 'основной' }));
    }
    head.appendChild(titleWrap);

    const headActions = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
    if (!isPrimary) {
      headActions.appendChild(el('button', {
        type: 'button',
        class: 'admin-btn admin-btn--mini',
        'data-branch-primary': id,
      }, ['Сделать основным']));
    }
    const up = el('button', {
      type: 'button',
      class: 'admin-btn admin-btn--mini',
      'data-branch-move': id,
      'data-dir': '-1',
      'aria-label': 'Выше',
    }, ['↑']);
    const down = el('button', {
      type: 'button',
      class: 'admin-btn admin-btn--mini',
      'data-branch-move': id,
      'data-dir': '1',
      'aria-label': 'Ниже',
    }, ['↓']);
    if (index === 0) {
      up.setAttribute('disabled', '');
    }
    if (index === ids.length - 1) {
      down.setAttribute('disabled', '');
    }
    headActions.appendChild(up);
    headActions.appendChild(down);
    headActions.appendChild(el('button', {
      type: 'button',
      class: 'admin-btn admin-btn--mini is-danger',
      'data-branch-delete': id,
    }, ['Удалить']));
    head.appendChild(headActions);
    card.appendChild(head);

    // ── Поля
    const grid = el('div', { class: 'admin-branch__grid' });

    /**
     * Создаёт поле филиала.
     *
     * @param {string} field Имя поля.
     * @param {string} label Подпись.
     * @param {string} [placeholder] Подсказка.
     * @param {string} [type] Тип input.
     * @returns {HTMLElement} Готовое поле.
     */
    const field = (fieldName, label, placeholder = '', type = 'text') => {
      const wrap = el('label', { class: 'admin-field' });
      wrap.appendChild(el('span', { class: 'admin-field__label', text: label }));
      wrap.appendChild(el('input', {
        class: 'admin-input',
        type,
        value: branch[fieldName] == null ? '' : String(branch[fieldName]),
        'data-branch-field': fieldName,
        'data-branch-id': id,
        placeholder,
        'aria-label': `${label} — ${branch.city || id}`,
      }));
      return wrap;
    };

    grid.appendChild(field('city', 'Город', 'Ереван'));
    grid.appendChild(field('address', 'Адрес', 'ул. Арташисян, 81/1'));
    grid.appendChild(field('addressExtra', 'Дополнительно', 'этаж, ориентир'));
    grid.appendChild(field('phone', 'Телефон как показывать', '+374 XX XXX XXX'));
    grid.appendChild(field('phoneRaw', 'Телефон для ссылки tel:', '+374XXXXXXXX'));
    grid.appendChild(field('mapUrl', 'Ссылка на карту', 'https://…'));
    grid.appendChild(field('phonePrefix', 'Код страны', '+374'));
    grid.appendChild(field('phoneDigits', 'Цифр после кода', '8', 'number'));
    card.appendChild(grid);

    if (isBare) {
      // Служебная запись, а не настоящий филиал. Удалять её нельзя:
      // на неё ссылаются чаты Telegram.
      card.appendChild(el('p', {
        class: 'admin-hint',
        text: 'Служебная запись: используется как запасной филиал. На сайте не показывается.',
      }));
    }

    container.appendChild(card);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ЭКСПОРТ И СБРОС
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Выгружает дельту в JSON-файл.
 *
 * Зачем файл, а не «опубликовать»: сайт статический, публиковать некуда.
 * Файл — единственный честный способ передать правки туда, где их увидят
 * посетители.
 *
 * @returns {void}
 */
function exportJson() {
  if (!hasOverrides()) {
    toast('Правок нет — выгружать нечего', 'err');
    return;
  }
  const payload = {
    ...draft,
    version: OVERRIDES_VERSION_LOCAL,
    exportedAt: new Date().toISOString(),
    // Подсказка для того, кто будет вносить это в config.js.
    note: 'Правки из админ-панели Crystal. Перенести в js/config.js или отдать разработчику.',
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = el('a', {
    href: url,
    download: `crystal-config-${new Date().toISOString().slice(0, 10)}.json`,
  });
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Отзываем URL после клика: иначе blob висит в памяти до перезагрузки.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Файл скачан');
}

/** Версия формата — импортируется из content, но дублируется здесь,
 *  чтобы экспорт не зависел от внутреннего имени. */
const OVERRIDES_VERSION_LOCAL = 1;

/**
 * Сбрасывает все правки с подтверждением.
 *
 * @returns {void}
 */
function resetAll() {
  const confirmed = window.confirm(
    'Сбросить все правки?\n\n'
    + 'Вернутся заводские цены, услуги, филиалы И все исправленные тексты '
    + '(включая армянские) — правки текстов хранятся отдельно и тоже удаляются.\n\n'
    + 'Это действие нельзя отменить.'
  );
  if (!confirmed) {
    return;
  }
  resetOverrides();
  i18n.clearTextOverrides();
  content = getContent();
  draft = readOverrides();
  renderAll();
  updateStatus();
  toast('Правки сброшены');
}

// ─────────────────────────────────────────────────────────────────────────────
// ТЕЛЕФОН И МЕССЕНДЖЕРЫ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Оставляет от номера только цифры и ведущий плюс.
 *
 * @param {string} value Ввод пользователя.
 * @returns {string} Номер в формате для ссылки tel:.
 */
function toPhoneRaw(value) {
  const trimmed = String(value || '').trim();
  const digits = trimmed.replace(/[^\d]/g, '');
  return digits ? `+${digits}` : '';
}

/**
 * Разбивает номер на группы для показа: +374 33-880-418.
 *
 * Зачем: заказчик вводит номер как придётся — со скобками, пробелами или
 * слитно. Показывать его обратно «+37433880418» неудобно читать, а
 * бросать введённое как есть значит держать на сайте три разных
 * написания одного числа.
 *
 * @param {string} raw Номер с плюсом или без.
 * @returns {string} Читаемый номер либо исходная строка, если формат незнаком.
 */
function formatPhone(raw) {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  // Армения: 374 + 8 цифр (две на оператора, три-три на номер).
  if (digits.length === 11 && digits.startsWith('374')) {
    return `+374 ${digits.slice(3, 5)}-${digits.slice(5, 8)}-${digits.slice(8)}`;
  }
  // Россия: 7 + 10 цифр.
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    const d = digits.startsWith('8') ? `7${digits.slice(1)}` : digits;
    return `+7 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7, 9)}-${d.slice(9)}`;
  }
  return String(raw || '').trim();
}

/**
 * Заполняет раздел «Телефон и контакты» из текущего состояния.
 *
 * @returns {void}
 */
function renderContacts() {
  const raw = $('[data-phone-raw]');
  const display = $('[data-phone-display]');
  const preview = $('[data-phone-preview]');
  const primaryId = content.primaryBranch;
  const branch = (content.branches && content.branches[primaryId]) || {};
  const rawValue = branch.phoneRaw || '';

  if (raw) {
    raw.value = rawValue;
  }
  if (display) {
    display.value = branch.phone || formatPhone(rawValue);
  }
  if (preview) {
    const shown = branch.phone || formatPhone(rawValue);
    setText(
      preview,
      rawValue
        ? `Основной филиал «${branch.city || primaryId}»: на сайте будет ${shown}, ссылка tel:${rawValue}`
        : 'Номер не задан — кнопки звонка и мессенджеров на сайте погашены.'
    );
  }

  const social = content.social || {};
  document.querySelectorAll('[data-social-field]').forEach((input) => {
    const network = input.getAttribute('data-social-field');
    const value = social[network];
    // Плейсхолдер-маркер в поле показывать нельзя: заказчик примет его за
    // реальное значение и не поймёт, почему кнопка гаснет.
    input.value = value && value.indexOf('[ЗАПОЛНИТЬ]') === -1 ? value : '';
  });
}

/**
 * Сохраняет номер телефона основного филиала и рассылает его по филиалам.
 *
 * @param {boolean} toAll Применить номер ко всем филиалам.
 * @returns {void}
 */
function savePhone(toAll) {
  const rawInput = $('[data-phone-raw]');
  const displayInput = $('[data-phone-display]');
  const raw = toPhoneRaw(rawInput ? rawInput.value : '');
  if (!raw) {
    toast('Номер пустой — впишите его в формате +37433880418', 'err');
    return;
  }
  // Минимум 8 цифр после кода страны: иначе заказчик случайно сотрёт часть
  // номера и на сайте появится ссылка в никуда.
  if (raw.replace(/\D/g, '').length < 10) {
    toast('Слишком короткий номер — проверьте, все ли цифры вписаны', 'err');
    return;
  }

  const display = (displayInput && displayInput.value.trim()) || formatPhone(raw);
  const ids = Object.keys(content.branches || {});
  const targets = toAll ? ids : [content.primaryBranch];

  targets.forEach((id) => {
    if (!content.branches[id]) {
      return;
    }
    content.branches[id].phoneRaw = raw;
    content.branches[id].phone = display;
  });

  persistBranches();
  commit(toAll ? 'Номер сохранён для всех филиалов' : 'Номер сохранён');
}

/**
 * Сохраняет ссылки мессенджеров.
 *
 * @returns {void}
 */
function saveSocial() {
  const social = {};
  document.querySelectorAll('[data-social-field]').forEach((input) => {
    social[input.getAttribute('data-social-field')] = input.value.trim();
  });
  draft.social = social;
  commit('Мессенджеры сохранены');
}

/**
 * Собирает ссылки WhatsApp и Telegram из сохранённого номера.
 *
 * @returns {void}
 */
function socialFromPhone() {
  const branch = content.branches[content.primaryBranch] || {};
  const digits = String(branch.phoneRaw || '').replace(/\D/g, '');
  if (!digits) {
    toast('Сначала сохраните номер телефона', 'err');
    return;
  }
  const wa = $(`[data-social-field="whatsapp"]`);
  const tg = $(`[data-social-field="telegram"]`);
  if (wa) {
    wa.value = `https://wa.me/${digits}`;
  }
  if (tg) {
    tg.value = `https://t.me/+${digits}`;
  }
  toast('Ссылки собраны — нажмите «Сохранить мессенджеры»');
}

// ─────────────────────────────────────────────────────────────────────────────
// РЕНДЕР ЦЕЛИКОМ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Перерисовывает все разделы.
 *
 * @returns {void}
 */
function renderAll() {
  try {
    renderServices();
    renderGroups();
    renderTexts();
    renderPhotos();
    renderBranches();
    renderContacts();
  } catch (error) {
    console.error('[crystal] admin: ошибка отрисовки', error);
    toast('Не удалось отрисовать панель — подробности в консоли', 'err');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ПЕРЕКЛЮЧЕНИЕ РАЗДЕЛОВ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Показывает один раздел панели и прячет остальные.
 *
 * @param {string} tab Идентификатор раздела.
 * @returns {void}
 */
function switchTab(tab) {
  document.querySelectorAll('[data-tab]').forEach((button) => {
    const active = button.getAttribute('data-tab') === tab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  document.querySelectorAll('[data-panel]').forEach((panel) => {
    const active = panel.getAttribute('data-panel') === tab;
    panel.classList.toggle('is-active', active);
    if (active) {
      panel.removeAttribute('hidden');
    } else {
      panel.setAttribute('hidden', '');
    }
  });
  // Запоминаем раздел в адресе: после перезагрузки заказчик вернётся
  // туда, где работал, а не на первую вкладку.
  try {
    window.history.replaceState(null, '', `#${tab}`);
  } catch (error) {
    // history недоступен в некоторых встроенных браузерах — не страшно.
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ОБРАБОТЧИКИ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Вешает все обработчики. Делегирование на document выбрано намеренно:
 * таблица перерисовывается целиком после каждого сохранения, и подписка
 * на конкретные кнопки терялась бы при каждом рендере.
 *
 * @returns {void}
 */
function bindEvents() {
  // ── Вкладки
  on(document, 'click', (event) => {
    const tab = event.target instanceof Element ? event.target.closest('[data-tab]') : null;
    if (tab) {
      switchTab(tab.getAttribute('data-tab'));
      return;
    }

    // ── Телефон и мессенджеры
    const phoneSave = event.target instanceof Element
      ? event.target.closest('[data-phone-save]')
      : null;
    if (phoneSave) {
      savePhone(false);
      return;
    }

    const phoneToAll = event.target instanceof Element
      ? event.target.closest('[data-phone-to-all]')
      : null;
    if (phoneToAll) {
      savePhone(true);
      return;
    }

    const socialSave = event.target instanceof Element
      ? event.target.closest('[data-social-save]')
      : null;
    if (socialSave) {
      saveSocial();
      return;
    }

    const socialBuild = event.target instanceof Element
      ? event.target.closest('[data-social-from-phone]')
      : null;
    if (socialBuild) {
      socialFromPhone();
      return;
    }

    // ── Экспорт и сброс
    const action = event.target instanceof Element
      ? event.target.closest('[data-action]')
      : null;
    if (action) {
      const name = action.getAttribute('data-action');
      if (name === 'export-json') {
        exportJson();
      } else if (name === 'reset') {
        resetAll();
      } else if (name === 'add-photo') {
        addPhoto();
      } else if (name === 'toggle-publish') {
        togglePublishPanel();
      } else if (name === 'save-publish') {
        savePublishSettings();
      } else if (name === 'check-publish') {
        runCheckAccess();
      } else if (name === 'pull-publish') {
        pullFromGithub();
      } else if (name === 'reset-text') {
        // Стоять здесь, а не в блоке ниже, обязательно: общий перехватчик
        // [data-action] срабатывает первым и делает return, поэтому
        // отдельная проверка после него никогда не выполнится. Именно на
        // этом кнопка «Вернуть исходный» сначала молча ничего не делала.
        resetTextOverride(action.getAttribute('data-key') || '');
      } else if (name === 'clear-texts') {
        clearAllTexts();
      }
      return;
    }

    // ── Услуги
    const delService = event.target instanceof Element
      ? event.target.closest('[data-delete-service]')
      : null;
    if (delService) {
      deleteService(delService.getAttribute('data-delete-service'));
      return;
    }

    const moveService = event.target instanceof Element
      ? event.target.closest('[data-move-service]')
      : null;
    if (moveService) {
      moveServiceItem(
        moveService.getAttribute('data-move-service'),
        Number(moveService.getAttribute('data-dir'))
      );
      return;
    }

    // ── Разделы прайса
    const delGroup = event.target instanceof Element
      ? event.target.closest('[data-delete-group]')
      : null;
    if (delGroup) {
      deleteGroup(delGroup.getAttribute('data-delete-group'));
      return;
    }

    const removeChip = event.target instanceof Element
      ? event.target.closest('[data-remove-chip]')
      : null;
    if (removeChip) {
      removeChipFromGroup(
        removeChip.getAttribute('data-group'),
        removeChip.getAttribute('data-remove-chip')
      );
      return;
    }

    const moveChip = event.target instanceof Element
      ? event.target.closest('[data-move-chip]')
      : null;
    if (moveChip) {
      moveChipInGroup(
        moveChip.getAttribute('data-group'),
        moveChip.getAttribute('data-move-chip'),
        Number(moveChip.getAttribute('data-dir'))
      );
      return;
    }

    const addChip = event.target instanceof Element
      ? event.target.closest('[data-add-chip]')
      : null;
    if (addChip) {
      addChipToGroup(addChip.getAttribute('data-add-chip'));
      return;
    }

    // ── Фоновое фото услуги: выбрать файл или убрать
    const svcImageFile = event.target instanceof Element
      ? event.target.closest('[data-service-image-file]')
      : null;
    if (svcImageFile) {
      const id = svcImageFile.getAttribute('data-service-image-file');
      const input = document.querySelector(`[data-service-image-input="${id}"]`);
      if (input) {
        input.click();
      }
      return;
    }

    const svcImageClear = event.target instanceof Element
      ? event.target.closest('[data-service-image-clear]')
      : null;
    if (svcImageClear) {
      clearServiceImage(svcImageClear.getAttribute('data-service-image-clear'));
      return;
    }

    // ── Фотографии
    const photoFile = event.target instanceof Element
      ? event.target.closest('[data-photo-file]')
      : null;
    if (photoFile) {
      const index = photoFile.getAttribute('data-photo-file');
      const input = document.querySelector(`[data-photo-file-input="${index}"]`);
      if (input) {
        input.click();
      }
      return;
    }

    const photoDelete = event.target instanceof Element
      ? event.target.closest('[data-photo-delete]')
      : null;
    if (photoDelete) {
      deletePhoto(Number(photoDelete.getAttribute('data-photo-delete')));
      return;
    }

    const photoUp = event.target instanceof Element
      ? event.target.closest('[data-photo-up]')
      : null;
    if (photoUp) {
      movePhoto(Number(photoUp.getAttribute('data-photo-up')), -1);
      return;
    }

    const photoDown = event.target instanceof Element
      ? event.target.closest('[data-photo-down]')
      : null;
    if (photoDown) {
      movePhoto(Number(photoDown.getAttribute('data-photo-down')), 1);
      return;
    }

    // ── Филиалы
    const primary = event.target instanceof Element
      ? event.target.closest('[data-branch-primary]')
      : null;
    if (primary) {
      setPrimaryBranch(primary.getAttribute('data-branch-primary'));
      return;
    }

    const branchDelete = event.target instanceof Element
      ? event.target.closest('[data-branch-delete]')
      : null;
    if (branchDelete) {
      deleteBranch(branchDelete.getAttribute('data-branch-delete'));
      return;
    }

    const branchMove = event.target instanceof Element
      ? event.target.closest('[data-branch-move]')
      : null;
    if (branchMove) {
      moveBranch(branchMove.getAttribute('data-branch-move'), Number(branchMove.getAttribute('data-dir')));
    }
  });

  // ── Тексты сайта: ввод в поле строки.
  //
  // Здесь нельзя сохранять на «change», как у цен: заказчик правит длинный
  // абзац, легко кликает мимо, а если поле теряет фокус без события change
  // (переключение вкладки, закрытие окна) — правка молча пропадёт.
  // Поэтому слушаем «input» с задержкой: пока человек печатает, в
  // хранилище ничего не пишется, а через секунду после последнего символа
  // текст сохраняется, применяется к странице и уходит коммитом.
  on(document, 'input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) {
      return;
    }
    const key = target.getAttribute('data-text-input');
    if (!key) {
      return;
    }
    // Подсветка потерянных подстановок — сразу, не дожидаясь сохранения:
    // заказчик должен увидеть проблему в момент, когда стёр {city}.
    markLostPlaceholders(target, key);

    window.clearTimeout(textsSaveTimer);
    textsSaveTimer = window.setTimeout(() => {
      const changed = saveTextOverride(key, target.value);
      if (changed) {
        commit('Текст сайта обновлён');
      }
    }, TEXTS_SAVE_DELAY);
  });

  // ── Уход фокуса из поля текста: сохраняем немедленно, не дожидаясь
  //    таймера. Иначе быстрый переход на другую вкладку оставил бы
  //    правку висеть в таймере, а он может не сработать.
  on(document, 'focusout', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) {
      return;
    }
    const key = target.getAttribute('data-text-input');
    if (!key) {
      return;
    }
    window.clearTimeout(textsSaveTimer);
    if (saveTextOverride(key, target.value)) {
      commit('Текст сайта обновлён');
    }
  });

  // ── Фильтры раздела «Тексты»
  on(document, 'input', (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.hasAttribute('data-texts-search')) {
      textsQuery = target.value;
      // Поиск перерисовывает список, но карточки создаются заново —
      // это дёшево, потому что фильтр оставляет единицы строк.
      renderTexts();
    }
  });

  on(document, 'change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLSelectElement)) {
      return;
    }
    if (target.hasAttribute('data-texts-lang')) {
      textsLang = target.value === 'hy' ? 'hy' : 'ru';
      renderTexts();
      return;
    }
    if (target.hasAttribute('data-texts-group')) {
      textsGroup = target.value;
      renderTexts();
      return;
    }
    if (target.hasAttribute('data-texts-changed')) {
      textsOnlyChanged = target.checked;
      renderTexts();
    }
  });

  // ── Ввод в полях таблицы услуг. Сохраняем на change, а не на каждый
  //    символ: иначе перерисовка на каждой букве сбивала бы курсор.
  on(document, 'change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    const priceId = target.getAttribute('data-service-price');
    if (priceId) {
      const value = parsePrice(target.value);
      if (value === null) {
        target.classList.add('is-invalid');
        toast('Цена должна быть числом не меньше нуля', 'err');
        return;
      }
      target.classList.remove('is-invalid');
      const service = (content.pricing.services || []).find((item) => item.id === priceId);
      if (service) {
        service.basePrice = value;
        persistServices();
        commit('Цена сохранена');
      }
      return;
    }

    const scaleId = target.getAttribute('data-service-scale');
    if (scaleId) {
      const service = (content.pricing.services || []).find((item) => item.id === scaleId);
      if (service) {
        service.scaleByClass = target.checked;
        persistServices();
        commit('Сохранено');
      }
      return;
    }

    const nameId = target.getAttribute('data-service-name');
    if (nameId) {
      const value = target.value.trim();
      if (!value) {
        target.classList.add('is-invalid');
        toast('Название не может быть пустым', 'err');
        return;
      }
      target.classList.remove('is-invalid');
      const service = (content.pricing.services || []).find((item) => item.id === nameId);
      if (service) {
        service.name = value;
        persistServices();
        commit('Название сохранено');
      }
      return;
    }

    const groupId = target.getAttribute('data-group-title');
    if (groupId) {
      const value = target.value.trim();
      if (!value) {
        target.classList.add('is-invalid');
        return;
      }
      const group = (content.pricelist.groups || []).find((item) => item.id === groupId);
      if (group) {
        group.title = value;
        // Ключ перевода снимаем: заголовок, заданный вручную, не должен
        // подменяться словарём при смене языка на сайте.
        delete group.titleKey;
        draft.pricelistGroups = content.pricelist.groups.map((item) => ({ ...item }));
        commit('Раздел сохранён');
      }
      return;
    }

    const photoIndex = target.getAttribute('data-photo-src');
    if (photoIndex !== null) {
      const items = (content.gallery && content.gallery.items) || galleryItems();
      items[Number(photoIndex)] = { src: target.value.trim() };
      content.gallery = { items };
      draft.gallery = { items: items.map((item) => ({ src: item.src || '' })) };
      commit('Путь сохранён');
      return;
    }

    // ── Телефон на вкладке «Телефон и контакты»
    //
    // Поле «как показывать» и поле «для ссылки» живут рядом, и заказчик
    // ждёт, что второе подставится само: вписывать один номер дважды —
    // верный способ получить на сайте ссылку tel: с чужими цифрами.
    // Галочка синхронизации отключаема: если понадобится написать номер
    // иначе, чем он звонится, её можно снять.
    if (target.matches('[data-phone-display]')) {
      const sync = $('[data-phone-sync]');
      if (sync && sync.checked) {
        const out = $('[data-phone-raw]');
        if (out) {
          out.value = toPhoneRaw(target.value);
        }
      }
      const preview = $('[data-phone-preview]');
      if (preview) {
        const shown = target.value.trim() || 'номер не задан';
        setText(preview, `На сайте будет ${shown}. Нажмите «Сохранить номер».`);
      }
      return;
    }

    if (target.matches('[data-phone-raw]')) {
      const display = $('[data-phone-display]');
      if (display) {
        display.value = formatPhone(target.value);
      }
      return;
    }

    // ── Путь к фону услуги
    const imageId = target.getAttribute('data-service-image');
    if (imageId !== null) {
      setServiceImage(imageId, target.value);
      return;
    }

    // ── Поля филиала
    const branchId = target.getAttribute('data-branch-id');
    const branchField = target.getAttribute('data-branch-field');
    if (branchId && branchField) {
      const branch = content.branches[branchId];
      if (!branch) {
        return;
      }
      let value = target.value.trim();
      if (branchField === 'phoneDigits') {
        const digits = Number(value);
        if (!Number.isInteger(digits) || digits < 4 || digits > 15) {
          target.classList.add('is-invalid');
          toast('Количество цифр — целое число от 4 до 15', 'err');
          return;
        }
        target.classList.remove('is-invalid');
        branch[branchField] = digits;
      } else {
        branch[branchField] = value;
      }
      persistBranches();
      commit('Филиал сохранён');
    }
  });

  // ── Файл фотографии выбран
  on(document, 'change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    const index = target.getAttribute('data-photo-file-input');
    if (index !== null && target.files && target.files[0]) {
      readPhotoFile(Number(index), target.files[0]);
      // Сбрасываем input: иначе повторный выбор того же файла не вызовет
      // change, и заказчик решит, что кнопка не работает.
      target.value = '';
    }
  });

  // ── Файл фона услуги выбран
  on(document, 'change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) {
      return;
    }
    const serviceId = target.getAttribute('data-service-image-input');
    if (serviceId !== null && target.files && target.files[0]) {
      readServiceImageFile(serviceId, target.files[0]);
      // Сбрасываем input: иначе повторный выбор того же файла не вызовет
      // change, и заказчик решит, что кнопка не работает.
      target.value = '';
    }
  });

  // ── Режим цен
  const modeBox = $('[data-price-mode]');
  if (modeBox) {
    on(modeBox, 'change', () => {
      // Режим правим в обеих структурах: и в pricing (калькулятор и
      // карточки), и в pricelist (таблица). Это одно решение заказчика,
      // и разъезжаться им нельзя.
      const mode = modeBox.checked ? 'fixed' : 'on-request';
      content.pricing.priceMode = mode;
      content.pricelist.priceMode = mode;
      draft.priceMode = mode;
      draft.pricelist = { ...(draft.pricelist || {}), priceMode: mode };
      commit(modeBox.checked ? 'Цены теперь видны на сайте' : 'Цены показываются «по запросу»');
    });
  }

  // ── Добавление услуги
  const addService = $('[data-add-service]');
  if (addService) {
    on(addService, 'submit', (event) => {
      event.preventDefault();
      addServiceFromForm(addService);
    });
  }

  // ── Добавление раздела
  const addGroup = $('[data-add-group]');
  if (addGroup) {
    on(addGroup, 'submit', (event) => {
      event.preventDefault();
      addGroupFromForm(addGroup);
    });
  }

  // ── Тексты под прайсом
  const texts = $('[data-pricelist-texts]');
  if (texts) {
    on(texts, 'submit', (event) => {
      event.preventDefault();
      const note = texts.querySelector('[name="note"]');
      const noteLang = texts.querySelector('[name="noteLang"]');
      const updated = texts.querySelector('[name="updated"]');
      const lang = (noteLang && noteLang.value) || 'ru';
      const value = note ? note.value.trim() : '';

      // Пишем в тот язык, который выбран. Объект сохраняем объектом:
      // иначе армянское примечание затрёт русское.
      const current = content.pricelist.note;
      if (typeof current === 'string') {
        content.pricelist.note = { ru: current, hy: '', [lang]: value };
        if (lang === 'ru') content.pricelist.note.ru = value;
      } else {
        content.pricelist.note = { ...(current || {}), [lang]: value };
      }
      content.pricelist.updated = updated ? updated.value.trim() : '';

      draft.pricelist = {
        ...(draft.pricelist || {}),
        note: content.pricelist.note,
        updated: content.pricelist.updated,
      };
      commit(`Примечание сохранено (${lang === 'hy' ? 'армянский' : 'русский'})`);
    });
  }

  // ── Добавление филиала
  const addBranch = $('[data-add-branch]');
  if (addBranch) {
    on(addBranch, 'submit', (event) => {
      event.preventDefault();
      addBranchFromForm(addBranch);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ИЗМЕНЕНИЯ: УСЛУГИ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Удаляет услугу и убирает её из разделов прайса.
 *
 * Убирать из прайса обязательно: строка, ссылающаяся на несуществующую
 * услугу, отрисовалась бы пустой или не отрисовалась вовсе — и заказчик
 * решил бы, что админка сломалась.
 *
 * @param {string} id Идентификатор услуги.
 * @returns {void}
 */
function deleteService(id) {
  const service = (content.pricing.services || []).find((item) => item.id === id);
  if (!service) {
    return;
  }
  const confirmed = window.confirm(
    `Удалить услугу «${serviceName(service)}»?\n\n`
    + 'Она исчезнет из прайса, из карточек на сайте и из списка в форме заявки.'
  );
  if (!confirmed) {
    return;
  }
  content.pricing.services = content.pricing.services.filter((item) => item.id !== id);
  reindex(content.pricing.services);
  (content.pricelist.groups || []).forEach((group) => {
    group.services = (group.services || []).filter((serviceId) => String(serviceId) !== id);
  });
  persistServices();
  draft.pricelistGroups = content.pricelist.groups.map((group) => ({ ...group }));
  commit('Услуга удалена');
}

/**
 * Двигает услугу в общем списке (влияет на порядок в форме и на сайте).
 *
 * @param {string} id Идентификатор услуги.
 * @param {number} dir -1 вверх, 1 вниз.
 * @returns {void}
 */
function moveServiceItem(id, dir) {
  const services = [...(content.pricing.services || [])].sort(
    (a, b) => (a.order || 0) - (b.order || 0)
  );
  const index = services.findIndex((item) => item.id === id);
  const target = index + dir;
  if (index < 0 || target < 0 || target >= services.length) {
    return;
  }
  const moved = services[index];
  services[index] = services[target];
  services[target] = moved;
  reindex(services);
  content.pricing.services = services;
  persistServices();
  commit('Порядок сохранён');
}

/**
 * Добавляет услугу из формы.
 *
 * @param {HTMLFormElement} form Форма добавления.
 * @returns {void}
 */
function addServiceFromForm(form) {
  const nameField = form.querySelector('[name="name"]');
  const idField = form.querySelector('[name="id"]');
  const priceField = form.querySelector('[name="price"]');
  const descField = form.querySelector('[name="desc"]');
  const scaleField = form.querySelector('[name="scale"]');

  const name = nameField ? nameField.value.trim() : '';
  if (!name) {
    if (nameField) {
      nameField.classList.add('is-invalid');
      nameField.focus();
    }
    toast('Впишите название услуги', 'err');
    return;
  }
  if (nameField) {
    nameField.classList.remove('is-invalid');
  }

  // ID необязателен: его можно вывести из названия. Но транслитерации
  // здесь нет намеренно — она дала бы «polirovka-far» вместо
  // «headlight-polish», и заказчик получил бы нечитаемый ключ.
  let id = toId(idField ? idField.value : '');
  if (!id) {
    id = toId(name);
  }
  if (!id) {
    id = `service-${Date.now().toString(36)}`;
  }

  const services = content.pricing.services || [];
  if (services.some((item) => item.id === id)) {
    if (idField) {
      idField.classList.add('is-invalid');
      idField.focus();
    }
    toast(`Услуга с ID «${id}» уже есть — укажите другой ID`, 'err');
    return;
  }
  if (idField) {
    idField.classList.remove('is-invalid');
  }

  const price = parsePrice(priceField ? priceField.value : '') ?? 0;

  services.push({
    id,
    name,
    desc: descField ? descField.value.trim() : '',
    basePrice: price,
    // scaleByClass по умолчанию true — так ведёт себя большинство услуг.
    scaleByClass: scaleField ? scaleField.checked : true,
    order: services.length + 1,
  });
  content.pricing.services = services;

  // Новую услугу сразу ставим в прайс: иначе заказчик добавил её и не
  // нашёл, а orphan-раздел на сайте — не то место, где он будет искать.
  const groups = content.pricelist.groups || [];
  const target = groups.find((group) => group.id === 'detailing') || groups[groups.length - 1];
  if (target) {
    target.services = [...(target.services || []), id];
  }

  persistServices();
  draft.pricelistGroups = groups.map((group) => ({ ...group }));

  form.reset();
  const scaleReset = form.querySelector('[name="scale"]');
  if (scaleReset) {
    scaleReset.checked = true;
  }
  commit(`Услуга «${name}» добавлена`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ИЗМЕНЕНИЯ: РАЗДЕЛЫ ПРАЙСА
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Сохраняет разделы прайса в черновик.
 *
 * @returns {void}
 */
function persistGroups() {
  draft.pricelistGroups = (content.pricelist.groups || []).map((group) => ({ ...group }));
}

/**
 * Удаляет раздел. Услуги при этом остаются в прайсе — они попадут
 * в общий блок в конце (на сайте это раздел «Прочее»).
 *
 * @param {string} id Идентификатор раздела.
 * @returns {void}
 */
function deleteGroup(id) {
  const group = (content.pricelist.groups || []).find((item) => item.id === id);
  if (!group) {
    return;
  }
  const count = (group.services || []).length;
  const confirmed = window.confirm(
    `Удалить раздел «${group.title || id}»?\n\n`
    + (count
      ? `${count} усл. останутся в прайсе и покажутся в блоке «Прочее» в конце.`
      : 'Раздел пуст.')
  );
  if (!confirmed) {
    return;
  }
  content.pricelist.groups = (content.pricelist.groups || []).filter((item) => item.id !== id);
  persistGroups();
  commit('Раздел удалён');
}

/**
 * Добавляет раздел из формы.
 *
 * @param {HTMLFormElement} form Форма добавления раздела.
 * @returns {void}
 */
function addGroupFromForm(form) {
  const titleField = form.querySelector('[name="title"]');
  const title = titleField ? titleField.value.trim() : '';
  if (!title) {
    if (titleField) {
      titleField.classList.add('is-invalid');
      titleField.focus();
    }
    toast('Впишите название раздела', 'err');
    return;
  }
  if (titleField) {
    titleField.classList.remove('is-invalid');
  }

  const groups = content.pricelist.groups || [];
  const id = toId(title) || `group-${Date.now().toString(36)}`;
  if (groups.some((group) => group.id === id)) {
    toast(`Раздел с ID «${id}» уже есть`, 'err');
    return;
  }

  // titleKey не задаём: перевода для нового раздела нет, и сайт возьмёт
  // title как есть. Так честнее, чем подставить чужой ключ и получить
  // заголовок не о том разделе.
  groups.push({ id, title, services: [] });
  content.pricelist.groups = groups;
  persistGroups();
  form.reset();
  commit(`Раздел «${title}» добавлен`);
}

/**
 * Убирает услугу из раздела.
 *
 * @param {string} groupId Идентификатор раздела.
 * @param {string} serviceId Идентификатор услуги.
 * @returns {void}
 */
function removeChipFromGroup(groupId, serviceId) {
  const group = (content.pricelist.groups || []).find((item) => item.id === groupId);
  if (!group) {
    return;
  }
  group.services = (group.services || []).filter((id) => String(id) !== serviceId);
  persistGroups();
  commit('Услуга убрана из раздела');
}

/**
 * Двигает услугу внутри раздела.
 *
 * @param {string} groupId Идентификатор раздела.
 * @param {string} serviceId Идентификатор услуги.
 * @param {number} dir -1 вверх, 1 вниз.
 * @returns {void}
 */
function moveChipInGroup(groupId, serviceId, dir) {
  const group = (content.pricelist.groups || []).find((item) => item.id === groupId);
  if (!group) {
    return;
  }
  const ids = [...(group.services || [])];
  const index = ids.indexOf(serviceId);
  const target = index + dir;
  if (index < 0 || target < 0 || target >= ids.length) {
    return;
  }
  const moved = ids[index];
  ids[index] = ids[target];
  ids[target] = moved;
  group.services = ids;
  persistGroups();
  commit('Порядок сохранён');
}

/**
 * Добавляет выбранную услугу в раздел.
 *
 * @param {string} groupId Идентификатор раздела.
 * @returns {void}
 */
function addChipToGroup(groupId) {
  const select = document.querySelector(`[data-add-chip-select="${groupId}"]`);
  if (!select) {
    return;
  }
  const serviceId = select.value;
  if (!serviceId) {
    return;
  }
  const group = (content.pricelist.groups || []).find((item) => item.id === groupId);
  if (!group) {
    return;
  }
  // Защита от дубля: услуга уже может быть в другом разделе, если её
  // туда положили в этой же сессии.
  const used = usedServiceIds(content.pricelist);
  if (used.has(serviceId)) {
    toast('Эта услуга уже есть в прайсе', 'err');
    return;
  }
  group.services = [...(group.services || []), serviceId];
  persistGroups();
  commit('Услуга добавлена в раздел');
}

// ─────────────────────────────────────────────────────────────────────────────
// ИЗМЕНЕНИЯ: ФОТОГРАФИИ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Текущий список плиток (из конфига, если дельты ещё нет).
 *
 * @returns {Array<{src: string}>} Плитки.
 */
function currentPhotos() {
  return ((content.gallery && content.gallery.items) || galleryItems()).map(
    (item) => ({ src: item.src || '' })
  );
}

/**
 * Сохраняет плитки в черновик.
 *
 * @param {Array<{src: string}>} items Плитки.
 * @returns {void}
 */
function persistPhotos(items) {
  content.gallery = { items };
  draft.gallery = { items: items.map((item) => ({ src: item.src || '' })) };
}

/**
 * Добавляет пустую плитку.
 *
 * @returns {void}
 */
function addPhoto() {
  const srcField = document.querySelector('[data-new-photo-src]');
  const src = srcField ? srcField.value.trim() : '';
  const items = currentPhotos();
  items.push({ src });
  persistPhotos(items);
  if (srcField) {
    srcField.value = '';
  }
  commit('Плитка добавлена');
}

/**
 * Удаляет плитку.
 *
 * @param {number} index Индекс плитки.
 * @returns {void}
 */
function deletePhoto(index) {
  const items = currentPhotos();
  if (index < 0 || index >= items.length) {
    return;
  }
  items.splice(index, 1);
  persistPhotos(items);
  commit('Плитка удалена');
}

/**
 * Меняет плитки местами.
 *
 * @param {number} index Индекс плитки.
 * @param {number} dir -1 влево, 1 вправо.
 * @returns {void}
 */
function movePhoto(index, dir) {
  const items = currentPhotos();
  const target = index + dir;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) {
    return;
  }
  const moved = items[index];
  items[index] = items[target];
  items[target] = moved;
  persistPhotos(items);
  commit('Порядок сохранён');
}

// ─────────────────────────────────────────────────────────────────────────────
// ИЗМЕНЕНИЯ: ФИЛИАЛЫ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Сохраняет филиалы в черновик.
 *
 * Филиалы хранятся и объектом (по id, для чтения сайтом), и массивом
 * (для порядка и для добавленных филиалов). Дублирование намеренное:
 * объект — то, чем пользуется сайт, массив — то, чем задаётся порядок.
 *
 * @returns {void}
 */
function persistBranches() {
  const branches = content.branches || {};
  draft.branches = {};
  Object.keys(branches).forEach((id) => {
    // В дельту пишем только настоящие филиалы: служебная запись (isBranch:
    // false) живёт в базовом конфиге и переопределять её незачем.
    //
    // ⚠️ ИСКЛЮЧЕНИЕ — ОСНОВНОЙ ФИЛИАЛ. Здесь стояла проверка без него, и
    // телефон Еревана нельзя было сохранить вообще: заказчик менял номер,
    // панель отвечала «Номер сохранён», а на сайте оставалось прежнее
    // число, потому что am (isBranch: false) в дельту не попадал. Телефон
    // основного филиала — самое частое, что здесь правят, поэтому его
    // пишем всегда: дороже оставить заказчика с несохранённым номером.
    if (branches[id].isBranch !== false || id === content.primaryBranch) {
      draft.branches[id] = { ...branches[id] };
    }
  });
  draft.branchList = Object.keys(branches).map((id) => ({ ...branches[id] }));
  draft.primaryBranch = content.primaryBranch;
}

/**
 * Делает филиал основным.
 *
 * @param {string} id Идентификатор филиала.
 * @returns {void}
 */
function setPrimaryBranch(id) {
  if (!content.branches[id]) {
    return;
  }
  content.primaryBranch = id;
  // Порядок ключей решает, какой филиал показывается первым в контактах,
  // поэтому основной переставляем в начало объекта, а не только помечаем.
  const ordered = {};
  ordered[id] = content.branches[id];
  Object.keys(content.branches).forEach((key) => {
    if (key !== id) {
      ordered[key] = content.branches[key];
    }
  });
  content.branches = ordered;
  persistBranches();
  commit('Основной филиал изменён');
}

/**
 * Удаляет филиал.
 *
 * @param {string} id Идентификатор филиала.
 * @returns {void}
 */
function deleteBranch(id) {
  const branch = content.branches[id];
  if (!branch) {
    return;
  }
  if (branch.isBranch === false) {
    toast('Служебную запись удалить нельзя: на неё ссылаются чаты заявок', 'err');
    return;
  }
  const ids = Object.keys(content.branches);
  if (ids.length <= 1) {
    toast('Нельзя удалить единственный филиал', 'err');
    return;
  }
  const confirmed = window.confirm(
    `Удалить филиал «${branch.city || id}»?\n\n`
    + 'Его адрес и телефон исчезнут с сайта, а заявки с этим филиалом перестанут приниматься.'
  );
  if (!confirmed) {
    return;
  }
  delete content.branches[id];
  if (content.primaryBranch === id) {
    // Основной удалён — им становится первый оставшийся. Оставить
    // primaryBranch указывающим в пустоту нельзя: заявки без выбора
    // филиала уходили бы в никуда.
    content.primaryBranch = Object.keys(content.branches)[0];
  }
  persistBranches();
  commit('Филиал удалён');
}

/**
 * Меняет филиалы местами.
 *
 * @param {string} id Идентификатор филиала.
 * @param {number} dir -1 вверх, 1 вниз.
 * @returns {void}
 */
function moveBranch(id, dir) {
  const ids = Object.keys(content.branches);
  const index = ids.indexOf(id);
  const target = index + dir;
  if (index < 0 || target < 0 || target >= ids.length) {
    return;
  }
  const moved = ids[index];
  ids[index] = ids[target];
  ids[target] = moved;
  const ordered = {};
  ids.forEach((key) => {
    ordered[key] = content.branches[key];
  });
  content.branches = ordered;
  persistBranches();
  commit('Порядок сохранён');
}

/**
 * Добавляет филиал из формы.
 *
 * @param {HTMLFormElement} form Форма добавления.
 * @returns {void}
 */
function addBranchFromForm(form) {
  const city = (form.querySelector('[name="city"]') || {}).value || '';
  const address = (form.querySelector('[name="address"]') || {}).value || '';
  const phone = (form.querySelector('[name="phone"]') || {}).value || '';
  const phoneRaw = (form.querySelector('[name="phoneRaw"]') || {}).value || '';

  const cityValue = String(city).trim();
  if (!cityValue) {
    toast('Впишите город', 'err');
    return;
  }

  // id филиала — латиница. Город на армянском не даст латиницу, поэтому
  // в этом случае используем метку времени: смысл id в том, чтобы он был
  // уникальным, а не читаемым.
  let id = toId(cityValue) || `branch-${Date.now().toString(36)}`;
  const branches = content.branches || {};
  let counter = 2;
  let base = id;
  while (branches[id]) {
    id = `${base}-${counter}`;
    counter += 1;
  }

  // phoneRaw подставляем из phone, если заказчик вписал только
  // человекочитаемый номер: сайт строит ссылку tel: из phoneRaw, и без
  // неё кнопка звонка не работала бы.
  const raw = String(phoneRaw).trim() || String(phone).replace(/[^\d+]/g, '');

  branches[id] = {
    id,
    isBranch: true,
    city: cityValue,
    address: String(address).trim(),
    addressExtra: '',
    phone: String(phone).trim(),
    phoneRaw: raw,
    mapUrl: '',
    telegramBranch: content.primaryBranch || id,
    phonePrefix: raw.slice(0, raw.startsWith('+374') ? 4 : 2),
    phoneDigits: 8,
  };
  content.branches = branches;
  persistBranches();
  form.reset();
  commit(`Филиал «${cityValue}» добавлен`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ЗАПУСК
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Точка входа панели.
 *
 * @returns {void}
 */
function boot() {
  // Хранилище надо разбудить ПЕРВЫМ делом. store.js по умолчанию считает
  // localStorage недоступным и пишет только в память процесса, пока не
  // вызван init(). Без этой строки панель выглядела работающей, но каждая
  // правка «сохранялась» в никуда и пропадала при перезагрузке.
  try {
    store.init();
  } catch (error) {
    console.warn('[crystal] admin: хранилище не инициализировалось', error);
  }

  // Всё под try/catch: без данных панель бессмысленна, но показать
  // понятную ошибку она обязана — пустая страница выглядела бы как
  // «сайт сломался».
  try {
    content = getContent();
    draft = readOverrides();
  } catch (error) {
    console.error('[crystal] admin: не удалось прочитать конфиг', error);
    const node = $('[data-admin-status]');
    if (node) {
      setText(node, 'Ошибка чтения конфига — подробности в консоли.');
      setAttr(node, 'data-tone', 'err');
    }
    return;
  }

  try {
    renderAll();
    initTextsFilters();
    renderTexts();
    renderPublishSettings();
    updateStatus();
    bindEvents();
  } catch (error) {
    console.error('[crystal] admin: ошибка инициализации', error);
    toast('Панель запустилась не полностью — подробности в консоли', 'err');
  }

  // Пока публикация не настроена, блок настроек раскрыт: иначе заказчик
  // правит цены, ждёт, что «должно улететь на сайт», и не находит, где
  // включить отправку.
  if (!publishConfigured(readPublishSettings())) {
    togglePublishPanel();
  }

  // Раздел из адреса (#branches) или первый по умолчанию.
  const hash = window.location.hash.replace('#', '');
  const tabs = Array.from(document.querySelectorAll('[data-tab]')).map(
    (node) => node.getAttribute('data-tab')
  );
  switchTab(tabs.includes(hash) ? hash : (tabs[0] || 'prices'));

  // Правки в другой вкладке браузера должны появиться и здесь: заказчик
  // может держать админку открытой в двух окнах.
  window.addEventListener('storage', (event) => {
    if (event.key && event.key.indexOf('crystal_') === 0) {
      content = getContent();
      draft = readOverrides();
      renderAll();
      updateStatus();
    }
  });

  document.documentElement.setAttribute('data-admin-ready', 'true');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
