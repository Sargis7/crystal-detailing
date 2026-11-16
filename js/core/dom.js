/**
 * Утилиты работы с DOM.
 *
 * Задача модуля — убрать из остального кода повторяющиеся однострочники
 * (поиск, создание, установка текста) и гарантировать, что пользовательские
 * данные никогда не попадают в innerHTML без экранирования.
 *
 * @module js/core/dom
 */

/**
 * Ищет один элемент.
 *
 * @param {string} selector CSS-селектор.
 * @param {ParentNode} [root=document] Корень поиска.
 * @returns {HTMLElement|null} Найденный элемент либо null.
 */
export function $(selector, root = document) {
  return root.querySelector(selector);
}

/**
 * Ищет все элементы.
 *
 * @param {string} selector CSS-селектор.
 * @param {ParentNode} [root=document] Корень поиска.
 * @returns {HTMLElement[]} Массив найденных элементов.
 */
export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/**
 * Создаёт элемент с атрибутами и содержимым.
 *
 * @param {string} tag Имя тега.
 * @param {Object<string, string>} [attrs={}] Атрибуты; ключ 'text' → textContent,
 *     ключ 'html' → innerHTML (использовать ТОЛЬКО с доверенными строками).
 * @param {(Node|string)[]} [children=[]] Дочерние узлы.
 * @returns {HTMLElement} Созданный элемент.
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([name, value]) => {
    if (value === null || value === undefined) {
      return;
    }
    if (name === 'text') {
      node.textContent = String(value);
    } else if (name === 'html') {
      node.innerHTML = String(value);
    } else if (name === 'class') {
      node.className = String(value);
    } else {
      node.setAttribute(name, String(value));
    }
  });
  (children || []).forEach((child) => {
    // null/undefined — это осознанное «дочернего узла нет» (например,
    // необязательная подпись). Молча пропускаем: appendChild(null) бросает
    // TypeError и роняет всю отрисовку блока из-за одной пустой строки.
    if (child === null || child === undefined || child === false) {
      return;
    }
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  });
  return node;
}

/**
 * Безопасно устанавливает текст элемента.
 *
 * @param {HTMLElement|null} node Целевой элемент.
 * @param {string} value Текст.
 * @returns {void}
 */
export function setText(node, value) {
  if (node) {
    node.textContent = value == null ? '' : String(value);
  }
}

/**
 * Устанавливает атрибут, если элемент существует.
 *
 * @param {HTMLElement|null} node Целевой элемент.
 * @param {string} name Имя атрибута.
 * @param {string|number|null} value Значение; null удаляет атрибут.
 * @returns {void}
 */
export function setAttr(node, name, value) {
  if (!node) {
    return;
  }
  if (value === null || value === undefined) {
    node.removeAttribute(name);
    return;
  }
  node.setAttribute(name, String(value));
}

/**
 * Переключает CSS-класс по булеву условию.
 *
 * @param {HTMLElement|null} node Целевой элемент.
 * @param {string} className Класс.
 * @param {boolean} enabled Включить или снять.
 * @returns {void}
 */
export function toggleClass(node, className, enabled) {
  if (!node) {
    return;
  }
  node.classList.toggle(className, Boolean(enabled));
}

/**
 * Экранирует спецсимволы HTML. Обязательна для любой интерполяции
 * пользовательских данных в разметку.
 *
 * @param {*} value Любое значение.
 * @returns {string} Безопасная строка.
 */
export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Универсальный рендер списка: очищает контейнер и наполняет его
 * элементами, созданными фабрикой.
 *
 * @param {HTMLElement|null} container Контейнер.
 * @param {Array<*>} items Данные для рендера.
 * @param {(item: *, index: number) => Node|null} factory Фабрика элемента.
 * @returns {void}
 */
export function renderList(container, items, factory) {
  if (!container) {
    return;
  }
  container.textContent = '';
  (items || []).forEach((item, index) => {
    const node = factory(item, index);
    if (node) {
      container.appendChild(node);
    }
  });
}

/**
 * Обработчик с автоматическим снятием по сигналу AbortSignal,
 * если он передан, — иначе обычная подписка.
 *
 * @param {EventTarget|null} target Источник события.
 * @param {string} type Тип события.
 * @param {EventListener} handler Обработчик.
 * @param {AddEventListenerOptions} [options={}] Опции; для scroll/touch
 *     рекомендуется `{ passive: true }`.
 * @returns {void}
 */
export function on(target, type, handler, options = {}) {
  if (target) {
    target.addEventListener(type, handler, options);
  }
}

/**
 * Плавно прокручивает документ к элементу с учётом высоты липкой шапки.
 *
 * @param {HTMLElement|null} node Целевой элемент.
 * @param {number} [offset=80] Дополнительный отступ сверху в пикселях.
 * @returns {void}
 */
export function scrollToElement(node, offset = 80) {
  if (!node) {
    return;
  }
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const top = node.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top: Math.max(top, 0), behavior: reduceMotion ? 'auto' : 'smooth' });
}

/**
 * Блокирует или разблокирует прокрутку страницы (для лайтбокса и меню).
 *
 * @param {boolean} locked true — заблокировать.
 * @returns {void}
 */
export function lockScroll(locked) {
  document.body.classList.toggle('no-scroll', Boolean(locked));
}

export default { $, $$, el, setText, setAttr, toggleClass, escapeHtml, renderList, on, scrollToElement, lockScroll };
