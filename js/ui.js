/**
 * Reveal-анимации при скролле, аккордеоны, копирование в буфер, тултипы.
 *
 * Модуль отвечает только за «косметику поведения»: он не знает ни о ценах,
 * ни о форме. Всё, что меняет данные, живёт в calculator.js / form.js.
 *
 * @module js/ui
 */

import { $, $$, on, el, setText, setAttr, toggleClass, escapeHtml } from './core/dom.js';
import { on as onBus, EVENTS } from './core/events.js';
import { t } from './core/i18n.js';
import { CONFIG, isPlaceholder } from './config.js';
import { getContent } from './core/content.js';

/** Класс, который вешает CSS-переход появления. */
const REVEAL_CLASS = 'is-revealed';

/**
 * Шаг округления цены, если в конфиге он не задан.
 * Значение обязано совпадать с vin/pricing.js: карточка и калькулятор
 * должны показывать одну и ту же сумму.
 *
 * @type {number}
 */
const DEFAULT_ROUND_TO = 100;

/**
 * Текущий язык документа — источник истины для формата подписей,
 * а не состояние i18n: ui.js не должен зависеть от его внутренностей.
 *
 * @returns {boolean} true, если язык армянский.
 */
function langIsArmenian() {
  return document.documentElement.getAttribute('lang') === 'hy';
}

/**
 * Округляет цену до шага из конфига — та же формула, что в калькуляторе.
 *
 * @param {number} value Значение.
 * @returns {number} Округлённое значение.
 */
/**
 * Конфиг с учётом правок из админки.
 *
 * Читать напрямую CONFIG здесь нельзя: админка хранит дельту в
 * localStorage, а CONFIG — статический объект модуля. Пока карточки
 * брали CONFIG, правки цен из админки в них не доходили, а прайс при
 * этом показывал новые числа — два блока на одной странице расходились.
 *
 * @returns {Object} Слитый конфиг (база + дельта).
 */
function data() {
  try {
    return getContent();
  } catch (error) {
    console.warn('[crystal] ui: не удалось прочитать правки, работаем с CONFIG', error);
    return CONFIG;
  }
}

/**
 * Округляет цену до шага из CONFIG.pricing.roundTo.
 *
 * @param {number} value Значение.
 * @returns {number} Округлённое значение.
 */
function roundPrice(value) {
  const pricing = data().pricing || {};
  const configured = pricing.roundTo;
  const step = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ROUND_TO;
  return Math.round(value / step) * step;
}

/**
 * Возвращает описание услуги из CONFIG.pricing.services.
 *
 * @param {string} serviceId Идентификатор услуги.
 * @returns {{id: string, basePrice: number, scaleByClass: boolean, order: number}|null} Услуга.
 */
function findService(serviceId) {
  const services = (data().pricing || {}).services || [];
  return services.find((service) => service.id === serviceId) || null;
}

/**
 * Множитель класса по его номеру.
 *
 * @param {number} carClass Класс 1–5.
 * @returns {number} Множитель; 1, если класс неизвестен.
 */
function classMultiplier(carClass) {
  const multipliers = (data().pricing || {}).classMultipliers || {};
  const value = Number(multipliers[carClass]);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Форматирует цену под текущий язык: разделитель разрядов — обычный
 * пробел, знак рубля отделяется тем же пробелом.
 *
 * @param {number} value Цена.
 * @returns {string} Готовая строка, например «17 900» или «8 500».
 */
function formatPrice(value) {
  let formatted;
  try {
    formatted = new Intl.NumberFormat('ru-RU', { useGrouping: true }).format(value);
  } catch (error) {
    // Intl есть в любом браузере, который понимает ES-модули. Ветка нужна,
    // чтобы сбой форматирования не оставил карточку без цены вовсе.
    formatted = String(value);
  }
  // В русской локали Intl ставит узкий неразрывный пробел, который в
  // браузере выглядит как перенос строки между «17» и «900». Заменяем
  // на обычный пробел: он визуально тот же и переносится предсказуемо.
  return formatted.replace(/\u00A0|\u202F/g, ' ');
}

/**
 * Подпись под ценой карточки. Вид подписи задан в разметке атрибутом
 * data-price-hint на самом узле подсказки.
 *
 * @param {HTMLElement} card Карточка услуги.
 * @param {number} carClass Класс автомобиля из data-price-class.
 * @returns {string} Локализованный текст подписи.
 */
function priceHint(card, carClass) {
  const node = card.querySelector('.card__hint');
  const kind = node ? node.getAttribute('data-price-hint') : '';

  if (kind === 'fixed-price') {
    return t('services.hintFixedPrice');
  }
  if (kind === 'on-request') {
    return t('services.hintOnRequest');
  }
  // Вид по умолчанию — 'class'. Номер подставляется через {class}, а не
  // приклеивается к переводу: в русском номер идёт после слова «класса»,
  // в армянском — после «Դաս». Склейка из двух готовых строк сломала бы
  // один из языков, но словари об этом молчат, поэтому ловушка
  // зафиксирована здесь.
  return t('services.hintClass', { class: carClass });
}

/**
 * Ставит карточке фоновое фото услуги, если оно задано в админке.
 *
 * Фото опционально: без него карточка выглядит как раньше, с собственной
 * заливкой и градиентом. Поэтому «нет фото» — это не ошибка, а норма,
 * и в консоль о ней писать нечего.
 *
 * Картинку обязательно проверяем на загрузку. Ссылка на несуществующий
 * файл иначе оставила бы карточку с полупрозрачным фоном и тёмным
 * затемнением, но без фотографии — текст стал бы плохо читаемым, а
 * причина была бы не видна. При ошибке слой убирается целиком, и
 * карточка возвращается к обычному виду.
 *
 * @param {HTMLElement} card Карточка услуги.
 * @param {Object} service Услуга из CONFIG.
 * @returns {void}
 */
function renderServicePhoto(card, service) {
  const src = typeof service.image === 'string' ? service.image.trim() : '';
  const existing = card.querySelector('.card__photo');

  if (!src || isPlaceholder(src)) {
    // Смена языка перерисовывает карточки: фото могло быть убрано в
    // админке, и старый слой нужно снять, а не оставить висеть.
    if (existing) {
      existing.remove();
      card.classList.remove('card--has-photo');
    }
    const staleVeil = card.querySelector('.card__veil');
    if (staleVeil) {
      staleVeil.remove();
    }
    return;
  }

  // Уже стоит это же фото — второй раз не пересобираем: иначе каждая
  // перерисовка заново тянула бы картинку из кэша и мигала.
  if (existing && existing.getAttribute('data-src') === src) {
    return;
  }
  if (existing) {
    existing.remove();
  }

  const layer = el('div', { class: 'card__photo', 'data-src': src, 'aria-hidden': 'true' });
  const img = el('img', { src, alt: '', loading: 'lazy', decoding: 'async' });

  img.addEventListener('error', () => {
    // Файла нет или путь с опечаткой: убираем затемнение вместе с фото,
    // иначе текст остался бы на тёмной подложке без картинки.
    layer.remove();
    const veil = card.querySelector('.card__veil');
    if (veil) {
      veil.remove();
    }
    card.classList.remove('card--has-photo');
    console.warn(`[crystal] ui: фото услуги "${service.id}" не загрузилось: ${src}`);
  });

  layer.appendChild(img);

  // Порядок важен: фото первым, затем затемнение. Слой затемнения
  // создаём только если его ещё нет.
  card.insertBefore(layer, card.firstChild);
  if (!card.querySelector('.card__veil')) {
    card.insertBefore(el('div', { class: 'card__veil', 'aria-hidden': 'true' }), layer.nextSibling);
  }
  card.classList.add('card--has-photo');
}

/**
 * Приводит одну карточку услуги к состоянию, которое задаёт CONFIG.
 *
 * Число берётся из CONFIG (basePrice × множитель класса), а не из
 * разметки: литерал в HTML рано или поздно разойдётся с прайсом и сайт
 * пообещает цену, которой нет.
 *
 * @param {HTMLElement} card Карточка (article.card--service).
 * @param {HTMLElement} priceNode Узел цены с data-price-service и data-price-class.
 * @returns {void}
 */
function renderServiceCard(card, priceNode) {
  // Услуга — первый токен data-price-service. Класс автомобиля берётся из
  // data-price-class; он несёт СВОЙ класс на каждую услугу (комплекс-мойка
  // опубликована для класса 2, подкапотное — для класса 3), поэтому брать
  // «класс по умолчанию» на все карточки нельзя.
  const serviceId = String(priceNode.getAttribute('data-price-service') || '').trim();
  const classRaw = String(priceNode.getAttribute('data-price-class') || '').trim();

  if (!serviceId) {
    return;
  }

  const service = findService(serviceId);
  if (!service) {
    console.warn(`[crystal] ui: карточка ссылается на услугу "${serviceId}", которой нет в CONFIG.pricing.services`);
    return;
  }

  const fromNode = card.querySelector('.card__price-from');
  const currencyNode = card.querySelector('.card__price-cur');
  const hintNode = card.querySelector('.card__hint');
  const linkNode = card.querySelector('.card__link');

  renderServicePhoto(card, service);

  const parsedClass = Number(classRaw);
  const carClass = Number.isInteger(parsedClass) && parsedClass >= 1 && parsedClass <= 5
    ? parsedClass
    : (((data().pricing || {}).defaultClass) || 2);

  // Числа не публикуются: посетитель видит «Цена по запросу», а действие
  // карточки — не расчёт, а заявка. «от» и «₽» в этом режиме бессмысленны.
  if (!showsFixedPrices()) {
    setText(priceNode, t('services.onRequest'));
    setText(hintNode, t('services.onRequestHint'));
    if (linkNode) {
      // Движок i18n переводит статическую разметку через data-i18n, а здесь
      // подпись задаёт скрипт — атрибут снимаем, чтобы смена языка не
      // вернула «Подробнее» поверх «Узнать цену».
      setAttr(linkNode, 'data-i18n', null);
      setText(linkNode, t('services.ctaOnRequest'));
    }
    setAttr(fromNode, 'hidden', '');
    setAttr(currencyNode, 'hidden', '');
    toggleClass(priceNode, 'card__price-value--request', true);
    return;
  }

  const total = roundPrice(
    service.scaleByClass ? service.basePrice * classMultiplier(carClass) : service.basePrice
  );

  toggleClass(priceNode, 'card__price-value--request', false);
  setText(priceNode, formatPrice(total));
  setText(hintNode, priceHint(card, carClass));
  if (linkNode) {
    // В режиме чисел ссылка снова ведёт в калькулятор, поэтому её подпись
    // статическая — движку i18n достаточно вернуть data-i18n.
    setAttr(linkNode, 'data-i18n', 'services.detail');
    setText(linkNode, t('services.detail'));
  }
  setAttr(fromNode, 'hidden', null);
  setAttr(currencyNode, 'hidden', null);
}

/**
 * Перерисовывает все карточки услуг. Вызывается при старте и при смене
 * языка: подписи и формат цены созданы в JS, движок i18n их не видит.
 *
 * @returns {void}
 */
export function renderServiceCards() {
  // Атрибут data-price-service стоит на .card__price-value, а не на самой
  // карточке: он адресует цену, а не услугу. Карточку находим снизу вверх.
  $$('[data-price-service]').forEach((priceNode) => {
    const card = priceNode.closest('.card--service');
    if (!card) {
      return;
    }
    try {
      renderServiceCard(card, priceNode);
    } catch (error) {
      // Одна сломанная карточка не должна лишать посетителя остальных.
      console.error('[crystal] ui: карточка услуги не отрисована', card, error);
    }
  });
}

/**
 * Показывает ли сайт конкретные суммы (в противовес «по запросу»).
 * Как в calculator.js: режим цен задаётся единственным ключом CONFIG.
 *
 * @returns {boolean} true, если числа можно показывать.
 */
function showsFixedPrices() {
  return ((data().pricing || {}).priceMode) === 'fixed';
}

/**
 * Ставит на <html> атрибуты режима цен и текущего языка — по ним CSS
 * решает, какую часть карточки цены показывать. Режим приходит из
 * CONFIG, поэтому разметка и стили согласованы с прайсом, а не с
 * значениями, скопированными в HTML вручную.
 *
 * @returns {void}
 */
export function initPriceMode() {
  const root = document.documentElement;
  setAttr(root, 'data-price-mode', showsFixedPrices() ? 'fixed' : 'on-request');
  setAttr(root, 'data-lang', langIsArmenian() ? 'hy' : 'ru');
}

/**
 * Уважение к настройке «уменьшить движение»: если пользователь просил
 * систему отключить анимации, мы не запускаем наблюдатель вовсе, а
 * сразу показываем контент.
 *
 * @returns {boolean} true, если анимации нужно отключить.
 */
function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Показывает все элементы немедленно, без анимации.
 *
 * @param {NodeListOf<Element>|Element[]} nodes Элементы.
 * @returns {void}
 */
function revealAll(nodes) {
  nodes.forEach((node) => node.classList.add(REVEAL_CLASS));
}

/**
 * Инициализирует появление блоков при прокрутке.
 *
 * @returns {void}
 */
export function initReveal() {
  const nodes = $$('[data-reveal]');
  if (!nodes.length) {
    return;
  }

  if (prefersReducedMotion() || typeof IntersectionObserver === 'undefined') {
    revealAll(nodes);
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add(REVEAL_CLASS);
          // Появились один раз — дальше наблюдать незачем.
          observer.unobserve(entry.target);
        }
      });
    },
    { rootMargin: '0px 0px -10% 0px', threshold: 0.05 }
  );

  nodes.forEach((node) => observer.observe(node));
}

/**
 * Инициализирует аккордеоны (FAQ и подобное).
 *
 * Разметка ожидается такая:
 *   <div class="acc">
 *     <button class="acc__head" aria-expanded="false" aria-controls="id">…</button>
 *     <div class="acc__body" id="id" hidden>…</div>
 *   </div>
 *
 * @returns {void}
 */
export function initAccordions() {
  $$('.acc__head').forEach((head) => {
    on(head, 'click', () => {
      const expanded = head.getAttribute('aria-expanded') === 'true';
      const bodyId = head.getAttribute('aria-controls');
      const body = bodyId ? document.getElementById(bodyId) : null;
      const item = head.closest('.acc');

      // Аккордеон ведёт себя как «один открыт» — так предсказуемее на мобильных.
      if (item) {
        const group = item.parentElement;
        if (group) {
          group.querySelectorAll('.acc').forEach((sibling) => {
            if (sibling === item) {
              return;
            }
            sibling.classList.remove('is-open');
            const sibHead = sibling.querySelector('.acc__head');
            const sibBodyId = sibHead ? sibHead.getAttribute('aria-controls') : null;
            const sibBody = sibBodyId ? document.getElementById(sibBodyId) : null;
            if (sibHead) {
              sibHead.setAttribute('aria-expanded', 'false');
            }
            if (sibBody) {
              sibBody.hidden = true;
            }
          });
        }
      }

      head.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      if (item) {
        item.classList.toggle('is-open', !expanded);
      }
      if (body) {
        body.hidden = expanded;
      }
    });
  });
}

/**
 * Кнопки «скопировать телефон».
 *
 * Значение не лежит в разметке: кнопка носит путь к нему в CONFIG
 * (data-copy-phone="branches.ru.phone"), поэтому текст для буфера берётся
 * из конфига — иначе после смены номера копировался бы старый.
 *
 * @returns {void}
 */
export function initCopyButtons() {
  $$('[data-copy-phone]').forEach((button) => {
    // Если телефон филиала ещё не заполнен, кнопка копирования бесполезна:
    // нажатие не даёт ни буфера, ни подтверждения, и выглядит как поломка.
    // Гасим её сразу — тем же способом, каким main.js гасит пустые ссылки.
    const configured = resolveConfigPath(button.getAttribute('data-copy-phone') || '');
    if (typeof configured !== 'string' || !configured.trim() || isPlaceholder(configured)) {
      button.setAttribute('aria-disabled', 'true');
      button.setAttribute('tabindex', '-1');
    }

    on(button, 'click', async () => {
      const path = button.getAttribute('data-copy-phone') || '';
      const value = resolveConfigPath(path);
      if (typeof value !== 'string' || !value.trim() || isPlaceholder(value)) {
        return;
      }

      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(value);
        } else {
          // Запасной путь для http:// и старых браузеров.
          const helper = document.createElement('textarea');
          helper.value = value;
          helper.setAttribute('readonly', '');
          helper.style.position = 'absolute';
          helper.style.left = '-9999px';
          document.body.appendChild(helper);
          helper.select();
          document.execCommand('copy');
          document.body.removeChild(helper);
        }

        button.classList.add('is-done');
        // Подтверждение показываем подсказкой, а не подменой иконки:
        // у кнопки нет текстового узла, только символ ⧉.
        button.setAttribute('title', t('contacts.copied'));
        button.setAttribute('aria-label', t('contacts.copied'));
      } catch (error) {
        // Копирование — удобство, а не функция. Молча оставляем как было.
        console.warn('[crystal] ui: не удалось скопировать в буфер', error);
      }

      window.setTimeout(() => {
        button.classList.remove('is-done');
        button.setAttribute('title', t('contacts.copyPhone'));
        button.setAttribute('aria-label', t('contacts.copyPhone'));
      }, 2000);
    });
  });
}

/**
 * Читает значение по пути вида 'branches.ru.phone' из конфига с правками.
 *
 * Дублирует одноимённую функцию из main.js намеренно: ui.js не должен
 * зависеть от точки входа — иначе получится цикл импортов.
 *
 * @param {string} path Путь через точку.
 * @returns {*} Значение или null.
 */
function resolveConfigPath(path) {
  if (!path) {
    return null;
  }
  return path.split('.').reduce((node, key) => (node ? node[key] : null), data());
}

/**
 * Обновляет подписи внутри динамически отрисованных блоков при смене языка.
 * Статическая разметка переводится движком i18n через data-i18n; здесь —
 * то, что i18n перевести не может (например, уже подставленные значения).
 *
 * @returns {void}
 */
export function initLanguageSync() {
  onBus(EVENTS.I18N_CHANGED, () => {
    // Кнопка «скопировано» могла остаться в промежуточном состоянии —
    // возвращаем её в исходный вид, чтобы подпись не залипла на старом языке.
    $$('[data-copy-phone].is-done').forEach((button) => {
      button.classList.remove('is-done');
      button.setAttribute('title', t('contacts.copyPhone'));
      button.setAttribute('aria-label', t('contacts.copyPhone'));
    });

    // Служебный маркер для CSS: на армянском строки в среднем на 25–30 %
    // длиннее русских, и часть заголовков требует чуть меньшего кегля.
    // Атрибут data-lang ставит main.js — здесь только доводим его до
    // актуального значения, если смена языка пришла из i18n раньше.
    if (typeof window !== 'undefined' && window.__CRYSTAL_LANG) {
      document.documentElement.setAttribute('data-lang', window.__CRYSTAL_LANG);
    }

    // Подписи карточек услуг собраны в JS (цена, подсказка, режим) и
    // перевести их через data-i18n движок не может — перерисовываем сами.
    renderServiceCards();
  });
}

/**
 * Точка входа модуля.
 *
 * @returns {void}
 */
export function init() {
  initPriceMode();
  renderServiceCards();
  initReveal();
  initAccordions();
  initCopyButtons();
  initLanguageSync();
}

export default { init, initReveal, initAccordions, initCopyButtons, initPriceMode, renderServiceCards };
