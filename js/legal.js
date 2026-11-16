/**
 * Точка входа юридических страниц (legal/*.html).
 *
 * Отдельный модуль, а не main.js, по двум причинам. Во-первых, main.js
 * подключает калькулятор, галерею, форму и баннер cookie — на юридической
 * странице таких блоков нет, и половина модулей искала бы отсутствующие
 * элементы. Во-вторых, документ должен оставаться читаемым без JavaScript:
 * если скрипт не выполнился, посетитель увидит текст политики, а не пустой
 * экран.
 *
 * Что модуль делает:
 *   1. Определяет язык синхронно (общий движок i18n) и переводит разметку.
 *   2. Подставляет реквизиты оператора из CONFIG.legal.
 *   3. Подсвечивает незаполненные реквизиты — вместо «undefined» и пустых
 *      мест посетитель и заказчик видят маркер и пояснение.
 *
 * Чего модуль НЕ делает: не выдумывает реквизиты. Пока заказчик не передал
 * наименование, ИНН и адрес, в документе стоит пометка «ожидает заполнения».
 * Это осознанный компромисс: страница выглядит незавершённой, зато не
 * содержит ложных юридических сведений.
 *
 * @module js/legal
 */

import { CONFIG, isPlaceholder } from './config.js';
import * as i18n from './core/i18n.js';
import * as store from './core/store.js';
import * as events from './core/events.js';
import { $, $$ } from './core/dom.js';

/** Карта путей CONFIG.legal → ключ подписи в словаре. */
const REQUISITE_LABELS = {
  name: 'legal.name',
  inn: 'legal.inn',
  ogrn: 'legal.ogrn',
  tin: 'legal.tin',
  address: 'legal.address',
  email: 'legal.email',
};

/**
 * Запускает функцию, не позволяя её сбою остановить остальную инициализацию.
 *
 * @param {string} name Имя шага для консоли.
 * @param {() => void} starter Функция шага.
 * @returns {void}
 */
function safeInit(name, starter) {
  try {
    starter();
  } catch (error) {
    console.error(`[crystal] Юридическая страница: шаг «${name}» не выполнен`, error);
  }
}

/**
 * Читает значение из CONFIG по пути вида 'legal.operatorRu.name'.
 *
 * @param {string|null} path Путь через точку.
 * @returns {*} Значение либо null.
 */
function resolveConfigPath(path) {
  if (!path) {
    return null;
  }
  return path.split('.').reduce((node, key) => (node ? node[key] : null), CONFIG);
}

/**
 * Наполняет один элемент реквизита.
 *
 * Три случая, и все три должны выглядеть по-разному:
 *   • значение заполнено      → обычный текст;
 *   • значение не заполнено   → маркер «[ЗАПОЛНИТЬ]» в подсветке + пояснение,
 *                               какой именно ключ ждёт заказчика;
 *   • самого поля нет в CONFIG → не оставляем пустоту, сообщаем о пропуске.
 *
 * @param {HTMLElement} node Элемент (dd), который нужно наполнить.
 * @returns {void}
 */
function fillRequisite(node) {
  const path = node.getAttribute('data-legal-requisite');
  const field = path ? path.split('.').pop() : '';
  const labelKey = REQUISITE_LABELS[field] || null;
  const value = resolveConfigPath(path);

  node.textContent = '';

  if (isPlaceholder(value)) {
    // Маркер показывается явно: заказчик должен видеть, что подставлять
    // сюда что-либо — его задача, а не что страница сломалась.
    const mark = document.createElement('span');
    mark.className = 'legal-fill';
    mark.textContent = String(value == null || String(value).trim() === ''
      ? '[ЗАПОЛНИТЬ]'
      : value);
    node.appendChild(mark);

    const note = document.createElement('span');
    note.className = 'legal-req__note';
    note.textContent = labelKey
      ? `${i18n.t(labelKey)}: ${i18n.t('legal.fillRequired')} (${path})`
      : `${i18n.t('legal.fillRequired')} (${path})`;
    node.appendChild(note);
    return;
  }

  node.textContent = String(value);
}

/**
 * Подставляет в документ версию и дату обновления политики.
 *
 * Незаполненная дата — такая же заглушка, как реквизиты, и оформляется
 * тем же классом: пустая метка «Обновлено:» без значения выглядит как
 * опечатка вёрстки, а не как незаполненное поле.
 *
 * @returns {void}
 */
function fillPolicyMeta() {
  const version = CONFIG.legal ? CONFIG.legal.policyVersion : null;
  const updated = CONFIG.legal ? CONFIG.legal.policyUpdated : null;

  $$('[data-legal-version]').forEach((node) => {
    node.textContent = isPlaceholder(version) ? i18n.t('legal.fillRequired') : String(version);
  });

  $$('[data-legal-updated]').forEach((node) => {
    node.textContent = '';
    if (isPlaceholder(updated)) {
      const mark = document.createElement('span');
      mark.className = 'legal-fill';
      mark.textContent = '[ЗАПОЛНИТЬ]';
      node.appendChild(mark);
      node.appendChild(document.createTextNode(` ${i18n.t('legal.fillRequired')}`));
      return;
    }
    node.textContent = String(updated);
  });
}

/**
 * Отмечает в документе все места, которые ждут данных заказчика.
 *
 * Элементов с атрибутом data-legal-fill в разметке нет — это программный
 * маркер: если ни одно поле не заполнено, в начале каждого документа
 * появляется сводное предупреждение. Так заказчик видит проблему, не
 * выискивая жёлтые пометки по всему тексту.
 *
 * @returns {void}
 */
function applyFillState() {
  let anyMissing = false;
  let anyFilled = false;

  $$('[data-legal-requisite]').forEach((node) => {
    if (isPlaceholder(resolveConfigPath(node.getAttribute('data-legal-requisite')))) {
      anyMissing = true;
    } else {
      anyFilled = true;
    }
  });

  if (isPlaceholder(CONFIG.legal ? CONFIG.legal.policyUpdated : null)) {
    anyMissing = true;
  }

  const banner = $('[data-legal-fill-notice]');
  if (!banner) {
    return;
  }
  // Предупреждение показываем ровно до тех пор, пока реквизиты не переданы:
  // после заполнения config.js блок исчезает вместе с проблемой, а не
  // остаётся висеть как «постоянная часть» документа.
  banner.hidden = !anyMissing;
  banner.setAttribute('aria-hidden', anyMissing ? 'false' : 'true');

  if (anyMissing && !anyFilled) {
    console.info(
      '[crystal] Юридические реквизиты не заполнены: все значения в CONFIG.legal ' +
      'остаются заглушками [ЗАПОЛНИТЬ]. Документы нельзя публиковать в таком виде.'
    );
  }
}

/**
 * Проставляет абсолютный адрес страницы в canonical и og:url.
 *
 * Путь берётся из data-canonical-path на самом теге, а не из
 * location.pathname: юридические страницы лежат в подкаталоге, и вывести
 * из адреса, какая это именно страница, надёжно нельзя — при открытии
 * через file:// или при переписывании адресов на сервере путь окажется
 * другим, и canonical укажет не туда.
 *
 * Пока CONFIG.brand.siteUrl не заполнен, функция ничего не делает:
 * подставить туда «[ЗАПОЛНИТЬ]» или собрать адрес из location.origin
 * нельзя — на локальной машине это дало бы http://127.0.0.1:8000/, и
 * поисковик запомнил бы его как канонический адрес документа.
 *
 * @returns {void}
 */
function applyCanonicalUrls() {
  const siteUrl = CONFIG.brand ? CONFIG.brand.siteUrl : null;
  if (typeof siteUrl !== 'string' || !siteUrl.trim() || isPlaceholder(siteUrl)) {
    return;
  }

  const base = siteUrl.trim().replace(/\/+$/, '');
  const absolute = (path) => (path ? `${base}/${path}` : `${base}/`);

  // Путь этой страницы внутри сайта — один и тот же для canonical и og:url.
  const canonicalNode = $('link[rel="canonical"]');
  const path = canonicalNode ? canonicalNode.getAttribute('data-canonical-path') : null;

  if (canonicalNode) {
    canonicalNode.setAttribute('href', absolute(path));
  }

  $$('meta[property="og:url"]').forEach((node) => {
    node.setAttribute('content', absolute(path));
  });
}

/**
 * Точка входа.
 *
 * @returns {void}
 */
function boot() {
  safeInit('store', () => store.init());

  // Язык — синхронно и до всего остального: инлайн-скрипт в <head> уже
  // выставил lang для CSS, здесь заменяются сами тексты.
  let lang = 'ru';
  safeInit('i18n', () => {
    lang = i18n.init();
  });

  try {
    window.__CRYSTAL_LANG = lang;
    document.documentElement.setAttribute('data-lang', lang);
  } catch (error) {
    console.warn('[crystal] Юридическая страница: не удалось опубликовать язык', error);
  }

  safeInit('реквизиты', () => {
    $$('[data-legal-requisite]').forEach(fillRequisite);
  });
  safeInit('метаданные документа', fillPolicyMeta);
  safeInit('состояние заполнения', applyFillState);
  safeInit('canonical', applyCanonicalUrls);

  // Пояснения к незаполненным реквизитам собираются в JS и содержат
  // переведённые подписи — движок i18n их не видит и сам не обновит.
  // Без этой подписки смена языка оставила бы пометки на прежнем языке.
  events.on(events.EVENTS.I18N_CHANGED, () => {
    safeInit('реквизиты после смены языка', () => {
      $$('[data-legal-requisite]').forEach(fillRequisite);
    });
    safeInit('метаданные после смены языка', fillPolicyMeta);
  });

  document.documentElement.setAttribute('data-app-ready', 'true');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

export default { boot };
