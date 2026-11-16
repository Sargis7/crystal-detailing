/**
 * Галерея работ: сетка, премиальные заглушки, лайтбокс.
 *
 * ПОЧЕМУ ЗАГЛУШКИ, А НЕ ПУСТЫЕ <img>
 * Заказчик берёт реальные фото с Яндекс.Карт самостоятельно. До этого момента
 * галерея не должна выглядеть сломанной: вместо битых картинок рисуются
 * градиентные плитки с подписью, что сюда встанет реальная работа.
 *
 * КАК ПОСТАВИТЬ РЕАЛЬНЫЕ ФОТО — два независимых пути, оба поддерживаются:
 *
 *  1. Ничего не менять в HTML. Положить файлы assets/gallery/photo-1.jpg …
 *     photo-6.jpg с именами из GALLERY_ITEMS ниже. Модуль сам найдёт плитки
 *     по data-gallery-item, подставит <img> внутрь и скроет подпись-заглушку.
 *     Это предпочтительный путь: разметка остаётся нетронутой.
 *     Пока фото нет, плитку занимает assets/gallery/photo-N.svg — временная
 *     заглушка с номером и именем будущего файла. Она существует только
 *     благодаря запасному пути в sourceFor(): .svg берётся, если клиент
 *     не проставил data-gallery-src. Положите .jpg рядом — и он победит.
 *
 *  2. Прописать пути вручную: добавить в плитку атрибут data-gallery-src
 *     с адресом картинки. Он имеет приоритет над GALLERY_ITEMS — удобно,
 *     когда у работ разные имена файлов.
 *
 * @module js/gallery
 */

import { $, $$, on, el, setText, lockScroll } from './core/dom.js';
import { on as onBus, EVENTS } from './core/events.js';
import { t } from './core/i18n.js';

/**
 * @typedef {Object} GalleryItem
 * @property {string} src Путь к изображению.
 * @property {string} altKey Ключ перевода для alt.
 * @property {string} captionKey Ключ перевода для подписи.
 * @property {string} [tagKey] Ключ перевода для ярлыка (услуга).
 */

/**
 * СПИСОК РАБОТ.
 *
 * ЗАМЕНИТЬ: положите свои фото в assets/gallery/ под именами photo-1.jpg …
 * photo-6.jpg и убедитесь, что имена здесь совпадают. Требования к фото:
 * 1600×1200 px, JPG, до 400 КБ каждое, единая обработка по цвету.
 *
 * Если .jpg нет, плитка останется заглушкой — сайт не сломается.
 * Подробная инструкция для заказчика: assets/gallery/README.md.
 *
 * Подписи и alt НЕ хранятся здесь: у галереи в словарях есть ключи
 * gallery.slotCaption / gallery.slotAria с интерполяцией {n}, поэтому
 * добавить седьмую работу можно одной строкой в этом массиве и одной
 * плиткой в HTML — словари править не придётся.
 *
 * @type {Array<{src: string}>}
 */
const GALLERY_ITEMS = [
  { src: 'assets/gallery/photo-1.jpg' },
  { src: 'assets/gallery/photo-2.jpg' },
  { src: 'assets/gallery/photo-3.jpg' },
  { src: 'assets/gallery/photo-4.jpg' },
  { src: 'assets/gallery/photo-5.jpg' },
  { src: 'assets/gallery/photo-6.jpg' },
];

/**
 * Временные заглушки плиток.
 *
 * Заказчик возьмёт реальные снимки из своей карточки на Яндекс.Картах,
 * но прямо сейчас их у него нет. Шесть плиток с «битой картинкой» читались
 * бы как сломанный сайт, поэтому каждая плитка получает оформленную
 * SVG-заглушку с номером работы и именем будущего файла.
 *
 * Пара «jpg + svg» на одну работу, а не общий список: файлы живут парами
 * photo-N.jpg / photo-N.svg, и когда .jpg появится, .svg просто станет
 * недостижим — удалять его не обязательно.
 *
 * Заглушка НЕ является фотографией. Класс has-photo ей не ставится
 * (см. hydrateTile): подпись «Замените это фото» остаётся видимой,
 * а лайтбокс показывает ту же заглушку, что и плитка, а не пустое окно.
 *
 * @type {Array<{src: string}>}
 */
const GALLERY_PLACEHOLDERS = [
  { src: 'assets/gallery/photo-1.svg' },
  { src: 'assets/gallery/photo-2.svg' },
  { src: 'assets/gallery/photo-3.svg' },
  { src: 'assets/gallery/photo-4.svg' },
  { src: 'assets/gallery/photo-5.svg' },
  { src: 'assets/gallery/photo-6.svg' },
];

/**
 * Плитки галереи, найденные в разметке. Заполняется в init().
 *
 * @type {HTMLElement[]}
 */
let tiles = [];

/** Индекс открытого изображения в лайтбоксе; -1 — закрыт. */
let activeIndex = -1;

/**
 * Путь к картинке для плитки: сначала атрибут data-gallery-src (его
 * проставляет заказчик вручную), затем — позиция в GALLERY_ITEMS.
 *
 * @param {HTMLElement} tile Плитка.
 * @param {number} index Индекс плитки.
 * @returns {string} Путь к изображению.
 */
function sourceFor(tile, index) {
  const custom = tile.getAttribute('data-gallery-src');
  if (custom && custom.trim()) {
    return custom.trim();
  }
  // Ожидаемый адрес реальной фотографии. Если заказчик положит её рядом
  // с заглушкой, sourceFor(tile, index, true) вернёт именно его.
  return GALLERY_ITEMS[index] ? GALLERY_ITEMS[index].src : '';
}

/**
 * Путь к временной заглушке плитки.
 *
 * @param {number} index Индекс плитки.
 * @returns {string} Путь к SVG-заглушке или пустая строка.
 */
function placeholderFor(index) {
  return GALLERY_PLACEHOLDERS[index] ? GALLERY_PLACEHOLDERS[index].src : '';
}

/**
 * Плитка показывает временную заглушку, а не фотографию работы.
 *
 * Нужен лайтбоксу: у заглушки своя, «шахматная» роль в вёрстке —
 * размер тот же, подпись та же, но показывать её как снимок нельзя,
 * иначе посетитель решит, что это и есть работа центра.
 *
 * @param {HTMLElement} tile Плитка.
 * @returns {boolean} true, если в плитке стоит заглушка.
 */
function isPlaceholder(tile) {
  const img = tile.querySelector('.g-tile__photo');
  if (!img) {
    return false;
  }
  return Boolean(img.getAttribute('data-placeholder'));
}

/**
 * Меняет номер работы в тексте подписи.
 *
 * Ключи gallery.slotCaption / slotAria / slotHint содержат {n}, потому что
 * номер — единственное, чем подписи-заглушки отличаются друг от друга.
 *
 * @param {string} key Ключ перевода.
 * @param {number} index Индекс плитки (с нуля).
 * @returns {string} Готовый текст.
 */
function slotText(key, index) {
  return t(key, { n: index + 1 });
}

/**
 * Подставляет фотографию в готовую плитку из разметки.
 *
 * Если файла нет — плитка остаётся премиальной заглушкой с исходным
 * градиентом и подписью «Замените это фото». Это не «сломанная картинка»,
 * а спроектированное состояние, поэтому битый <img> удаляется.
 *
 * @param {HTMLElement} tile Плитка.
 * @param {number} index Индекс плитки.
 * @returns {void}
 */
function hydrateTile(tile, index) {
  const src = sourceFor(tile, index);
  const label = tile.querySelector('.g-tile__label');
  const hint = tile.querySelector('.g-tile__hint');
  const num = tile.querySelector('.g-tile__num');

  if (label) {
    setText(label, slotText('gallery.slotCaption', index));
  }
  if (hint) {
    setText(hint, slotText('gallery.slotHint', index));
  }
  if (num) {
    setText(num, String(index + 1).padStart(2, '0'));
  }

  // Кнопка-плитка должна нести понятное имя для скринридера: внутри неё
  // только декоративные узлы, поэтому задаём aria-label сами.
  tile.setAttribute('aria-label', slotText('gallery.slotAria', index));

  if (!src) {
    return;
  }

  // Уже подставленную картинку не дублируем при обновлении после смены языка.
  if (tile.querySelector('.g-tile__photo')) {
    return;
  }

  const img = el('img', {
    class: 'g-tile__photo',
    src,
    alt: '',
    loading: 'lazy',
    decoding: 'async',
  });

  // ── ЛЕСТНИЦА ЗАПАСНЫХ ПУТЕЙ ──
  // Ступень 1: адрес, который выбрал заказчик своим data-gallery-src, или
  // ожидаемое фото photo-N.jpg. Не нашлось — переходим к заглушке.
  // Ступень 2: заглушка photo-N.svg. Не нашлась и она — возвращаем плитку
  // к её исходному градиенту с подписью.
  //
  // Каждый шаг отдельный обработчик с once: true, иначе после ошибки
  // загрузки img оставался бы без обработчика и плитка «просто исчезала».
  const placeholder = placeholderFor(index);

  const dropToHint = () => {
    // Файлов нет вообще — возвращаемся к заглушке. once: true, чтобы
    // повторная ошибка не крутила цикл удаления-добавления.
    img.remove();
    tile.classList.remove('has-photo', 'has-placeholder');
    if (hint) {
      hint.hidden = false;
    }
  };

  const onError = () => {
    if (placeholder && img.getAttribute('src') !== placeholder) {
      // .jpg ещё не положили — показываем оформленную SVG-заглушку.
      img.setAttribute('src', placeholder);
      img.setAttribute('data-placeholder', '');
      return;
    }
    dropToHint();
  };

  img.addEventListener('error', onError);

  img.addEventListener('load', () => {
    const isRealPhoto = !img.hasAttribute('data-placeholder');
    if (isRealPhoto) {
      tile.classList.add('has-photo');
      tile.classList.remove('has-placeholder');
      // Подпись «Замените это фото» уходит только после успешной загрузки
      // РЕАЛЬНОГО фото: на SVG-заглушке посетитель должен видеть, что
      // снимка ещё нет, иначе заглушка выдаёт себя за работу центра.
      if (hint) {
        hint.hidden = true;
      }
    } else {
      tile.classList.remove('has-photo');
      // Класс нужен только CSS: он гасит градиент-подложку и «лупу»,
      // потому что свою рамку SVG-заглушка несёт сама.
      tile.classList.add('has-placeholder');
      if (hint) {
        hint.hidden = false;
      }
    }
  }, { once: true });

  tile.appendChild(img);
}

/**
 * Открывает лайтбокс на указанном изображении.
 *
 * @param {number} index Индекс изображения.
 * @returns {void}
 */
function openLightbox(index) {
  const box = $('[data-lightbox]');
  const tile = tiles[index];
  if (!box || !tile || index < 0) {
    return;
  }

  activeIndex = index;

  const frame = $('[data-lightbox-frame]', box);
  const caption = $('[data-lightbox-caption]', box);
  const counter = $('[data-lightbox-counter]', box);
  const hint = $('[data-i18n="gallery.slotHint"]', box) || box.querySelector('.lightbox__hint');
  const bg = $('[data-lightbox-bg]', box);

  const src = sourceFor(tile, index);
  const hasPhoto = Boolean(src) && tile.classList.contains('has-photo');
  // Временная SVG-заглушка — это ещё не фотография. Рисовать её в лайтбоксе
  // как снимок нельзя: посетитель примет её за работу центра. Поэтому
  // показываем честную градиентную заглушку с подписью, как и раньше.
  const showsPlaceholder = isPlaceholder(tile);

  // В лайтбоксе показываем то же, что в плитке: либо фото, либо ту же
  // градиентную заглушку. Рисовать «пустое окно» нельзя — выглядит как сбой.
  if (frame) {
    let img = frame.querySelector('[data-lightbox-img]');
    if (hasPhoto) {
      if (!img) {
        img = el('img', { class: 'lightbox__photo', 'data-lightbox-img': '', alt: '' });
        frame.appendChild(img);
      }
      // Фотографию показываем по её настоящему адресу и обновляем только
      // при смене работы. Присваивать src на каждой перерисовке нельзя:
      // если .jpg пока нет, сработает error, но узел уже в DOM — лайтбокс
      // останется с «битой картинкой».
      if (img.getAttribute('src') !== src) {
        img.src = src;
      }
      img.alt = '';
      img.hidden = false;
      if (hint) {
        hint.hidden = true;
      }
    } else if (img) {
      img.hidden = true;
      if (hint) {
        hint.hidden = false;
      }
    }

    // Заглушку-фотографию из плитки в лайтбокс не переносим: скрытая
    // копия с прежним src догрузилась бы и «выстрелила» картинкой поверх
    // градиента при следующей ошибке загрузки.
    if (showsPlaceholder && img) {
      img.removeAttribute('src');
    }
  }

  // Фон заглушки повторяет фон плитки: g-tile__bg--1 … --6.
  if (bg && (!hasPhoto || showsPlaceholder)) {
    bg.className = `g-tile__bg g-tile__bg--${(index % 6) + 1}`;
  }

  if (caption) {
    setText(caption, slotText('gallery.slotCaption', index));
  }
  if (counter) {
    setText(counter, t('gallery.counter', { current: index + 1, total: tiles.length }));
  }

  box.hidden = false;
  box.setAttribute('aria-hidden', 'false');
  box.classList.add('is-open');
  lockScroll(true);

  const closeButton = $('[data-lightbox-close]', box);
  if (closeButton) {
    closeButton.focus();
  }
}

/**
 * Закрывает лайтбокс.
 *
 * @returns {void}
 */
function closeLightbox() {
  const box = $('[data-lightbox]');
  if (!box) {
    return;
  }
  activeIndex = -1;
  box.classList.remove('is-open');
  box.setAttribute('aria-hidden', 'true');
  box.hidden = true;
  lockScroll(false);
}

/**
 * Листает лайтбокс на шаг вперёд или назад.
 *
 * @param {number} step Направление: 1 или -1.
 * @returns {void}
 */
function stepLightbox(step) {
  if (activeIndex < 0 || tiles.length === 0) {
    return;
  }
  const next = (activeIndex + step + tiles.length) % tiles.length;
  openLightbox(next);
}

/**
 * Инициализирует галерею и лайтбокс.
 *
 * @returns {void}
 */
export function init() {
  tiles = $$('[data-gallery-item]');
  if (!tiles.length) {
    return;
  }

  tiles.forEach((tile, index) => {
    // Плитка в разметке — это <button>, поэтому клик и Enter уже работают.
    // Наш обработчик открывает лайтбокс поверх этого поведения.
    on(tile, 'click', () => openLightbox(index));
    hydrateTile(tile, index);
  });

  const box = $('[data-lightbox]');
  if (box) {
    const closeButton = $('[data-lightbox-close]', box);
    const prevButton = $('[data-lightbox-prev]', box);
    const nextButton = $('[data-lightbox-next]', box);

    $$('[data-lightbox-close]', box).forEach((node) => {
      on(node, 'click', closeLightbox);
    });
    if (prevButton) {
      on(prevButton, 'click', (event) => {
        event.stopPropagation();
        stepLightbox(-1);
      });
    }
    if (nextButton) {
      on(nextButton, 'click', (event) => {
        event.stopPropagation();
        stepLightbox(1);
      });
    }

    // Клавиатура: Esc, стрелки. Слушаем документ, но реагируем только
    // при открытом лайтбоксе — иначе стрелки перехватывались бы всегда.
    on(document, 'keydown', (event) => {
      if (activeIndex < 0) {
        return;
      }
      if (event.key === 'Escape') {
        closeLightbox();
      } else if (event.key === 'ArrowLeft') {
        stepLightbox(-1);
      } else if (event.key === 'ArrowRight') {
        stepLightbox(1);
      }
    });

    // Фокус не должен уходить за пределы диалога: aria-modal="true" обещает
    // это скринридеру, и обещание нужно выполнять.
    on(box, 'keydown', (event) => {
      if (event.key !== 'Tab') {
        return;
      }
      const focusable = $$(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        box
      ).filter((node) => !node.hidden);
      if (!focusable.length) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  // При смене языка обновляем подписи и aria. Плитки НЕ пересоздаём:
  // пересоздание заново запускало бы загрузку фотографий.
  onBus(EVENTS.I18N_CHANGED, () => {
    tiles.forEach((tile, index) => {
      const label = tile.querySelector('.g-tile__label');
      if (label) {
        setText(label, slotText('gallery.slotCaption', index));
      }
      const hint = tile.querySelector('.g-tile__hint');
      if (hint) {
        setText(hint, slotText('gallery.slotHint', index));
      }
      tile.setAttribute('aria-label', slotText('gallery.slotAria', index));

      const caption = $('[data-lightbox-caption]');
      if (caption && activeIndex === index) {
        setText(caption, slotText('gallery.slotCaption', index));
      }
      const counter = $('[data-lightbox-counter]');
      if (counter && activeIndex >= 0) {
        setText(counter, t('gallery.counter', { current: activeIndex + 1, total: tiles.length }));
      }
    });
  });
}

export default { init };
