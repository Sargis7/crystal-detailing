/**
 * ПРАЙС-ЛИСТ (#pricing).
 *
 * Строится из данных, а не из разметки — по трём причинам:
 *
 *  1. Удалённая в админке услуга должна исчезать отсюда САМА. Если
 *     продублировать строки в HTML, они останутся в прайсе после удаления,
 *     и клиент увидит услугу, которую центр не оказывает.
 *  2. Список услуг один — CONFIG.pricing.services, тот же, что у
 *     калькулятора и формы. Второй список в разметке неизбежно разойдётся.
 *  3. Разделы (группы) задаёт CONFIG.pricelist.groups, поэтому порядок
 *     строк меняется без правки HTML.
 *
 * Отдельно от js/ui.js: ui.js отвечает за уже существующую разметку
 * (карточки услуг), а здесь разметка создаётся целиком.
 *
 * @module js/pricelist
 */

import { getContent, KEY_OVERRIDES } from './core/content.js';
import { t, has, getLanguage } from './core/i18n.js';
import { $, el, setText, setAttr, on } from './core/dom.js';
import * as events from './core/events.js';
import * as store from './core/store.js';

/** @type {Object|null} Конфиг с правками; перечитывается при каждом рендере. */
let content = null;

/**
 * Показывать ли в прайсе суммы. Числа публикуются только при 'fixed';
 * при 'on-request' клиент видит «по запросу» — это текущий режим.
 *
 * @returns {boolean} true, если цены можно показывать.
 */
function showsFixedPrices() {
  const mode = content && content.pricelist && content.pricelist.priceMode;
  return mode === 'fixed';
}

/**
 * Форматирует сумму с пробелами между разрядами.
 * Своя копия, а не импорт из ui.js: ui.formatPrice не экспортируется,
 * и импортировать весь модуль карточек ради одной функции не стоит.
 *
 * @param {number} value Сумма.
 * @returns {string} Готовая строка.
 */
function formatPrice(value) {
  try {
    return new Intl.NumberFormat('ru-RU', { useGrouping: true })
      .format(value)
      .replace(/\u00A0|\u202F/g, ' ');
  } catch (error) {
    return String(value);
  }
}

/**
 * Название услуги: сначала словарь (переведено), затем значение из
 * конфига. Услуга считается добавленной в админке, если ключа в словаре нет.
 *
 * @param {Object} service Запись из pricing.services.
 * @returns {string} Название.
 */
function serviceTitle(service) {
  // has() — потому что t() возвращает сам ключ при отсутствии перевода,
  // и сравнивать строки значило бы полагаться на формат этой заглушки.
  if (has(`services.${service.id}.name`)) {
    return t(`services.${service.id}.name`);
  }
  return service.name || service.id;
}

/**
 * Описание услуги. В прайсе строка описания — это «подробность»
 * (pricelist.details), а не полный текст карточки: в таблице нужен
 * короткий уточняющий текст, а не абзац.
 *
 * @param {Object} service Запись из pricing.services.
 * @returns {string} Описание или пустая строка.
 */
function serviceDetail(service) {
  const details = (content.pricelist && content.pricelist.details) || {};
  if (typeof details[service.id] === 'string' && details[service.id].trim()) {
    return details[service.id].trim();
  }
  const descKey = `services.${service.id}.desc`;
  if (has(descKey)) {
    return t(descKey);
  }
  return service.desc || '';
}

/**
 * Значение в колонке цены.
 *
 * @param {Object} service Запись из pricing.services.
 * @returns {HTMLElement} Узел с ценой.
 */
function priceNode(service) {
  if (!showsFixedPrices()) {
    return el('span', { class: 'price-row__value price-row__value--request', text: t('pricing.priceOnRequest') });
  }
  const sum = Number(service.basePrice);
  if (!Number.isFinite(sum) || sum <= 0) {
    return el('span', { class: 'price-row__value price-row__value--request', text: t('pricing.priceOnRequest') });
  }
  // «от» — потому что перечислять цены строго по классу в таблице
  // значило бы обещать точную сумму до осмотра.
  return el('span', { class: 'price-row__value' }, [
    el('span', { class: 'price-row__from', text: t('pricing.priceFrom') }),
    document.createTextNode(' '),
    el('span', { class: 'price-row__sum', text: formatPrice(sum) }),
    document.createTextNode(' '),
    el('span', { class: 'price-row__cur', text: t('pricing.currency') }),
  ]);
}

/**
 * Одна строка прайса.
 *
 * @param {Object} service Запись из pricing.services.
 * @param {number} index Порядковый номер — для aria и для чередования фона.
 * @returns {HTMLElement} Строка.
 */
function row(service, index) {
  const detail = serviceDetail(service);
  const id = String(service.id);
  // href ведёт в форму, а не в калькулятор: кнопка «выбрать услугу»
  // должна работать при выключенном подборе по VIN.
  const cta = el('a', {
    class: 'price-row__cta',
    href: '#form',
    'data-prefill-service': id,
    'aria-label': `${t('pricing.ctaLead')}: ${serviceTitle(service)}`,
  }, [t('pricing.ctaLead')]);

  const left = el('div', { class: 'price-row__main' }, [
    el('span', { class: 'price-row__num', text: String(index + 1).padStart(2, '0'), 'aria-hidden': 'true' }),
    // .filter(Boolean) обязателен: у услуги, добавленной в админке, нет
    // описания, detail равен null, и el() падал на appendChild(null) —
    // падал весь прайс целиком, а не одна строка.
    el('div', { class: 'price-row__text' }, [
      el('p', { class: 'price-row__title', text: serviceTitle(service) }),
      detail ? el('p', { class: 'price-row__detail', text: detail }) : null,
    ].filter(Boolean)),
  ]);

  return el('li', { class: 'price-row', 'data-price-row': id }, [
    left,
    el('div', { class: 'price-row__aside' }, [priceNode(service), cta]),
  ]);
}

/**
 * Блок прайса — раздел с заголовком и строками.
 *
 * @param {Object} group Раздел из pricelist.groups.
 * @param {Map<string, Object>} byId Услуги по id.
 * @param {Object} counter Счётчик для сквозной нумерации (мутируется).
 * @returns {HTMLElement|null} Раздел либо null, если строк в нём нет.
 */
function groupBlock(group, byId, counter) {
  const ids = Array.isArray(group.services) ? group.services : [];
  const services = ids.map((id) => byId.get(String(id))).filter(Boolean);
  if (!services.length) {
    // Пустой раздел не показываем: заголовок без строк выглядит как
    // незаконченная вёрстка, а не как «здесь пока ничего нет».
    return null;
  }
  // Раздел из админки может прийти без ключа перевода — тогда берём его
  // title как есть. Ключ есть в словаре — побеждает словарь, чтобы
  // армянская версия не показывала русский заголовок.
  const title = group.titleKey && has(group.titleKey)
    ? t(group.titleKey)
    : (group.title || group.id || '');

  const rows = services.map((service) => {
    counter.value += 1;
    return row(service, counter.value - 1);
  });

  return el('div', { class: 'price-group', 'data-price-group': group.id || '' }, [
    el('h3', { class: 'price-group__title', text: title }),
    el('ul', { class: 'price-group__list' }, rows),
  ]);
}

/**
 * Услуги, которых нет ни в одном разделе. Показывать их надо: иначе
 * добавленная в админке услуга молча пропала бы из прайса, а заказчик
 * решил бы, что админка не работает. Складываем в раздел «Прочее».
 *
 * @param {Object} pricelist Данные прайса.
 * @param {Map<string, Object>} byId Услуги по id.
 * @returns {Object|null} Синтетический раздел либо null.
 */
function orphanGroup(pricelist, byId) {
  const listed = new Set();
  (pricelist.groups || []).forEach((group) => {
    (group.services || []).forEach((id) => listed.add(String(id)));
  });
  const orphans = Array.from(byId.keys()).filter((id) => !listed.has(id));
  if (!orphans.length) {
    return null;
  }
  return {
    id: 'other',
    titleKey: 'pricing.groupDetailing',
    title: 'Прочее',
    services: orphans,
  };
}

/**
 * Текст примечания под таблицей.
 *
 * Поддерживаются три формы значения в CONFIG.pricelist.note:
 *   - строка          → свой текст на обоих языках (если он непустой);
 *   - объект {ru, hy} → свой текст на конкретном языке;
 *   - пусто           → текст из словаря (pricing.note), т.е. переводимый.
 *
 * Пустая строка для текущего языка — это осознанное «здесь перевода нет»,
 * и в этом случае мы НЕ подставляем словарь: иначе заказчик не смог бы
 * намеренно оставить примечание только на одном языке.
 *
 * @param {string|Object|undefined} note
 * @returns {string}
 */
function resolveNote(note) {
  if (typeof note === 'string') {
    return note.trim() || t('pricing.note');
  }
  if (note && typeof note === 'object') {
    const lang = getLanguage();
    const value = typeof note[lang] === 'string' ? note[lang].trim() : '';
    return value;
  }
  return t('pricing.note');
}

/**
 * Перерисовывает весь прайс. Вызывается при старте, при смене языка и
 * после сохранения правок в админке (событие storage в другой вкладке).
 *
 * @returns {void}
 */
export function render() {
  const container = $('[data-pricing-list]');
  if (!container) {
    return;
  }

  try {
    content = getContent();
  } catch (error) {
    console.error('[crystal] pricelist: не удалось получить конфиг', error);
    return;
  }

  const pricelist = content.pricelist || {};
  const services = (content.pricing && content.pricing.services) || [];

  /** @type {Map<string, Object>} */
  const byId = new Map();
  services.forEach((service) => {
    if (service && service.id) {
      byId.set(String(service.id), service);
    }
  });

  const groups = (pricelist.groups || []).slice();
  const orphans = orphanGroup(pricelist, byId);
  if (orphans) {
    groups.push(orphans);
  }

  const counter = { value: 0 };
  const blocks = groups
    .map((group) => groupBlock(group, byId, counter))
    .filter(Boolean);

  container.textContent = '';

  if (!blocks.length) {
    container.appendChild(
      el('p', { class: 'pricing__empty', text: t('pricing.empty') })
    );
    setAttr(container, 'data-empty', 'true');
  } else {
    container.removeAttribute('data-empty');
    blocks.forEach((block) => container.appendChild(block));
  }

  setAttr(container, 'aria-label', t('pricing.ariaList'));

  // Примечание и дата актуальности.
  const noteNode = $('[data-pricing-note]');
  if (noteNode) {
    const parts = [];
    const note = resolveNote(pricelist.note);
    if (note) {
      parts.push(note);
    }
    const updated = typeof pricelist.updated === 'string' ? pricelist.updated.trim() : '';
    parts.push(updated ? t('pricing.updated', { date: updated }) : t('pricing.updatedNow'));
    setText(noteNode, parts.join(' '));
  }

  // Кнопка «Узнать точную цену» рядом с формой — на случай, если
  // посетитель прочитал таблицу, но так и не нажал ни на одну строку.
  const lang = getLanguage();
  if (lang) {
    setAttr(container, 'data-lang', lang);
  }
}

/**
 * Предзаполнение формы из строки прайса: нажатие «Узнать точную цену»
 * у конкретной услуги должно открыть форму с уже выбранной услугой,
 * иначе посетитель выбирает её второй раз вручную.
 *
 * @returns {void}
 */
function initRowClicks() {
  on(document, 'click', (event) => {
    const target = event.target instanceof Element
      ? event.target.closest('[data-prefill-service]')
      : null;
    if (!target) {
      return;
    }
    const serviceId = target.getAttribute('data-prefill-service');
    // Клик не отменяем: якорь #form отработает сам. Нам нужно только
    // положить выбор до того, как форма прочитает состояние.
    try {
      const select = document.querySelector('[data-form-service]');
      if (select && serviceId) {
        select.value = serviceId;
        // change — чтобы form.js пересчитал подписи, зависящие от услуги.
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } catch (error) {
      console.warn('[crystal] pricelist: не удалось предзаполнить услугу', error);
    }
  });
}

/**
 * Инициализация прайс-листа.
 *
 * Прайс целиком строится скриптом, поэтому смена языка сама по себе его
 * не переведёт: applyToDom проходит по data-i18n в разметке, а строк
 * прайса в разметке нет. Подписываемся на I18N_CHANGED и перерисовываем —
 * иначе армянская версия показывала бы русский прайс.
 *
 * @returns {void}
 */
export function init() {
  render();
  initRowClicks();
  events.on(events.EVENTS.I18N_CHANGED, () => render());

  // Правка в админке (соседняя вкладка) — перерисовать прайс сразу.
  // Событие storage приходит только в ДРУГИЕ вкладки, поэтому своя
  // вкладка админки перерисовывается сама, а витрина подхватывает правку
  // без перезагрузки. Ключ тут без префикса: store.js добавляет его сам.
  window.addEventListener('storage', (event) => {
    if (event.key === `${store.PREFIX}${KEY_OVERRIDES}`) {
      render();
    }
  });
}

export default { init, render };
