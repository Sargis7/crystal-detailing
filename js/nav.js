/**
 * Навигация: мобильное меню, подсветка активного раздела, кнопка «наверх».
 *
 * Модуль отвечает только за поведение шапки. Он не знает о языке, формах
 * и ценах — вся связь через DOM-атрибуты и шину событий.
 *
 * @module js/nav
 */

import { $, $$, toggleClass } from './core/dom.js';
import { on } from './core/events.js';
import { EVENTS } from './core/events.js';
import { scrollToElement, lockScroll } from './core/dom.js';

/** Порог прокрутки, после которого шапка «проявляется», px. */
const SCROLL_THRESHOLD = 24;

/** Порог появления кнопки «наверх», px. */
const TO_TOP_THRESHOLD = 600;

/**
 * Объект состояния модуля. Создаётся один раз в init(),
 * чтобы не искать элементы в DOM на каждое действие.
 *
 * @type {{
 *   header: HTMLElement|null,
 *   nav: HTMLElement|null,
 *   burger: HTMLElement|null,
 *   toTop: HTMLElement|null,
 *   links: HTMLElement[],
 *   sections: HTMLElement[],
 *   open: boolean
 * }}
 */
const state = {
  header: null,
  nav: null,
  burger: null,
  toTop: null,
  links: [],
  sections: [],
  open: false,
};

/** Инициализирован ли модуль — защита от повторного вызова init(). */
let initialized = false;

/**
 * Открывает или закрывает мобильное меню.
 *
 * Синхронизирует три вещи: CSS-класс на панели, aria-expanded на кнопке
 * и блокировку прокрутки страницы. Без последнего меню «проваливается»:
 * фон прокручивается под открытой панелью.
 *
 * @param {boolean} open Нужное состояние.
 * @returns {void}
 */
function setMenuOpen(open) {
  if (!state.nav || !state.burger) {
    return;
  }

  state.open = open;
  toggleClass(state.nav, 'is-open', open);
  state.burger.setAttribute('aria-expanded', open ? 'true' : 'false');
  // На планшете и выше меню всегда видно — блокировать прокрутку нельзя.
  lockScroll(open && window.matchMedia('(max-width: 900px)').matches);
}

/** Закрывает меню. Удобная обёртка для обработчиков. */
function closeMenu() {
  setMenuOpen(false);
}

/**
 * Переключает меню по клику на бургер.
 * @returns {void}
 */
function onBurgerClick() {
  setMenuOpen(!state.open);
}

/**
 * Обработчик прокрутки: состояние шапки, кнопка «наверх» и активный раздел.
 *
 * Вызывается на каждое событие scroll, поэтому внутри нет тяжёлых операций:
 * только чтение scrollY и две булевы проверки.
 *
 * @returns {void}
 */
function onScroll() {
  const y = window.scrollY || document.documentElement.scrollTop || 0;

  if (state.header) {
    toggleClass(state.header, 'is-scrolled', y > SCROLL_THRESHOLD);
  }

  if (state.toTop) {
    state.toTop.hidden = y < TO_TOP_THRESHOLD;
  }

  updateActiveLink(y);
}

/**
 * Подсвечивает пункт меню, соответствующий текущему разделу.
 *
 * Алгоритм: берём последний раздел, верх которого уже пройден на треть
 * экрана. Порог в треть экрана выбран потому, что подсветка «по верхней
 * границе» переключается слишком рано и раздражает при чтении.
 *
 * @param {number} y Текущая позиция прокрутки.
 * @returns {void}
 */
function updateActiveLink(y) {
  if (state.sections.length === 0) {
    return;
  }

  const threshold = y + window.innerHeight / 3;
  let currentId = '';

  for (const section of state.sections) {
    if (section.offsetTop <= threshold) {
      currentId = section.id;
    }
  }

  for (const link of state.links) {
    const href = link.getAttribute('href') || '';
    const isActive = currentId !== '' && href === `#${currentId}`;
    toggleClass(link, 'is-active', isActive);
  }
}

/**
 * Обработчик клика по пункту меню.
 *
 * Перехватывает переход, чтобы закрыть мобильное меню и учесть высоту
 * шапки при прокрутке — иначе заголовок раздела остаётся под шапкой.
 *
 * @param {MouseEvent} event Событие клика.
 * @returns {void}
 */
function onNavLinkClick(event) {
  const link = event.currentTarget;
  const href = link.getAttribute('href') || '';

  if (!href.startsWith('#') || href === '#') {
    return;
  }

  const target = document.getElementById(href.slice(1));
  if (!target) {
    return;
  }

  event.preventDefault();
  closeMenu();
  scrollToElement(target);

  // Обновляем адрес без перезагрузки: ссылку можно скопировать.
  if (window.history && typeof window.history.replaceState === 'function') {
    window.history.replaceState(null, '', href);
  }
}

/**
 * Плавно возвращает страницу наверх.
 * @returns {void}
 */
function onToTopClick() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
}

/**
 * Обработчик клавиатуры: Esc закрывает меню.
 *
 * @param {KeyboardEvent} event Событие клавиатуры.
 * @returns {void}
 */
function onKeydown(event) {
  if (event.key === 'Escape' && state.open) {
    closeMenu();
    if (state.burger) {
      state.burger.focus();
    }
  }
}

/**
 * Закрывает меню при переходе на десктопную ширину.
 *
 * Без этого меню остаётся «открытым» в состоянии и при возврате к узкой
 * ширине внезапно разворачивается.
 *
 * @returns {void}
 */
function onResize() {
  if (window.matchMedia('(max-width: 900px)').matches) {
    return;
  }
  if (state.open) {
    setMenuOpen(false);
  }
  lockScroll(false);
}

/**
 * Инициализирует модуль навигации.
 *
 * Находит элементы, вешает обработчики и выставляет начальное состояние.
 * Повторный вызов безопасен: модуль инициализируется один раз.
 *
 * @returns {void}
 */
export function init() {
  if (initialized) {
    return;
  }
  initialized = true;

  state.header = $('[data-header]');
  state.nav = $('[data-nav]');
  state.burger = $('[data-burger]');
  state.toTop = $('[data-to-top]');
  state.links = $$('.nav__link');

  // Разделы, к которым ведут ссылки меню. Собираем только существующие,
  // иначе updateActiveLink молча пропустит отсутствующий якорь.
  const ids = state.links
    .map((link) => (link.getAttribute('href') || '').replace('#', ''))
    .filter((id) => id !== '');

  state.sections = ids
    .map((id) => document.getElementById(id))
    .filter((node) => node !== null);

  if (state.burger) {
    state.burger.addEventListener('click', onBurgerClick);
  }

  state.links.forEach((link) => {
    link.addEventListener('click', onNavLinkClick);
  });

  if (state.toTop) {
    state.toTop.addEventListener('click', onToTopClick);
  }

  document.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onResize);

  // passive: true — прокрутка не блокируется, обработчик ничего
  // не отменяет и не вызывает preventDefault.
  window.addEventListener('scroll', onScroll, { passive: true });

  // Первичный расчёт: страница могла открыться уже прокрученной
  // (переход по якорю или перезагрузка на середине).
  onScroll();

  // Клик по ссылке внутри мобильного меню закрывает его,
  // даже если это ссылка на другой сайт или документ.
  const navList = $('.nav__list');
  if (navList) {
    navList.addEventListener('click', (event) => {
      const target = /** @type {HTMLElement} */ (event.target);
      if (target.closest('a') && window.matchMedia('(max-width: 900px)').matches) {
        closeMenu();
      }
    });
  }

  // Смена языка может изменить высоту шапки (длина подписей),
  // поэтому пересчитываем активную ссылку.
  on(EVENTS.I18N_CHANGED, () => {
    updateActiveLink(window.scrollY || 0);
  });
}

export default { init };
