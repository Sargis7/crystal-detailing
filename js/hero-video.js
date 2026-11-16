/**
 * ВИДЕО-ФОН ГЛАВНОГО ЭКРАНА.
 *
 * Задача модуля узкая: решить, СТОИТ ЛИ вообще грузить видео, и если да —
 * вставить его в #hero. Всё остальное (затемнение, кадрирование, слой
 * текста) живёт в CSS.
 *
 * ПОЧЕМУ НЕ ПРОСТО <video> В РАЗМЕТКЕ.
 * Видео — самый тяжёлый ресурс страницы (~3.8 МБ против ~200 КБ всего
 * остального). Тег в HTML заставил бы браузер качать его всегда: и на
 * старом телефоне с медленным интернетом, и у посетителя, который просил
 * систему не показывать анимацию, и на компьютере с отключённым
 * автовоспроизведением. Поэтому тег создаётся скриптом только после
 * проверок, а в разметке лежит лишь фон-подложка (градиенты + постер).
 *
 * ПОЧЕМУ АТРИБУТ muted ОБЯЗАТЕЛЕН.
 * Без него браузеры блокируют автовоспроизведение, и мы получили бы
 * трёхмегабайтный файл, который скачался и молча стоит на первом кадре.
 * muted + playsinline — единственная комбинация, которая честно
 * запускается сама, в том числе в iOS Safari.
 *
 * ЧЕГО МОДУЛЬ НЕ ДЕЛАЕТ.
 * Не управляет звуком, не показывает кнопок «пауза», не реагирует на
 * клик. Фоновое видео — декорация: у него aria-hidden, и никаких
 * элементов управления у него быть не должно, иначе он превращается в
 * контент, до которого надо добираться с клавиатуры.
 *
 * @module js/hero-video
 */

import { CONFIG } from './config.js';
import { getContent } from './core/content.js';
import { $ } from './core/dom.js';

/** Класс, по которому CSS узнаёт, что видео действительно играет. */
const PLAYING_CLASS = 'is-playing';

/** Класс, отличающий вертикальный постер для телефонов. */
const MOBILE_CLASS = 'hero__video--mobile';

/**
 * Считает ли система, что анимацию нужно уменьшить.
 *
 * @returns {boolean} true, если движущийся фон показывать не следует.
 */
function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Сохраняет ли браузер трафик посетителя.
 *
 * @returns {boolean} true, если включён режим экономии трафика.
 */
function prefersReducedData() {
  const connection = typeof navigator !== 'undefined'
    ? (navigator.connection || navigator.mozConnection || navigator.webkitConnection)
    : null;

  if (connection && (connection.saveData === true || connection.effectiveType === '2g' ||
      connection.effectiveType === 'slow-2g')) {
    return true;
  }

  // Некоторые сборки Chrome выставляют отдельный медиазапрос.
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-data: reduce)').matches;
}

/**
 * Читает настройки фона с учётом правок из админ-панели.
 *
 * @returns {Object} Блок background.
 */
function settings() {
  let source = CONFIG;
  try {
    source = getContent();
  } catch (error) {
    console.warn('[crystal] hero-video: не удалось прочитать правки, работаем с CONFIG', error);
  }
  return (source && source.background) || (CONFIG && CONFIG.background) || {};
}

/**
 * Проверяет, что путь пригоден для загрузки.
 *
 * @param {*} value Значение из конфига.
 * @returns {boolean} true, если это непустая строка без заглушки.
 */
function isUsablePath(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const text = value.trim();
  return text !== '' && !text.includes('[ЗАПОЛНИТЬ]');
}

/**
 * Ставит вертикальный постер на узкие экраны.
 *
 * Отдельный постер нужен потому же, почему и отдельный кроп: из кадра
 * 16:9 в окне телефона видно середину, и композиция рассыпается. Проще
 * отдать заранее обрезанную картинку, чем ждать, пока браузер
 * отмасштабирует ландшафтную под портретную рамку через object-fit.
 *
 * @param {HTMLElement} host Контейнер фона.
 * @param {string} mobilePath Путь к вертикальному постеру.
 * @param {string} desktopPath Путь к обычному постеру.
 * @returns {void}
 */
function setPoster(host, mobilePath, desktopPath) {
  if (!host) {
    return;
  }
  // Работающее видео закрывает постер целиком. Возвращать картинку на
  // ресайзе незачем: она снова окажется под непрозрачным кадром и
  // потратит память впустую.
  if (host.classList.contains(PLAYING_CLASS)) {
    return;
  }
  const narrow = typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 720px)').matches;

  const wanted = narrow && isUsablePath(mobilePath) ? mobilePath : desktopPath;
  if (!isUsablePath(wanted)) {
    return;
  }

  host.style.backgroundImage = `url("${wanted}")`;
  host.classList.toggle(MOBILE_CLASS, narrow && isUsablePath(mobilePath));
}
/**
 * Собирает тег <video> с источниками из конфига.
 *
 * Порядок источников важен: браузер берёт ПЕРВЫЙ поддерживаемый. WebM
 * идёт первым, потому что он легче; Safari его не понимает и честно
 * падает на MP4.
 *
 * @param {Object} config Блок background.
 * @returns {HTMLVideoElement} Готовый, но ещё не вставленный элемент.
 */
function buildVideo(config) {
  const video = document.createElement('video');
  video.className = 'hero__video';
  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.setAttribute('preload', 'auto');
  video.setAttribute('aria-hidden', 'true');
  video.setAttribute('tabindex', '-1');
  // Отключаем картинку в картинке и удалённое воспроизведение: фоновое
  // видео не должно предлагать себя в качестве медиаплеера.
  video.disablePictureInPicture = true;
  video.disableRemotePlayback = true;

  if (isUsablePath(config.videoWebm)) {
    const webm = document.createElement('source');
    webm.src = config.videoWebm.trim();
    webm.type = 'video/webm';
    video.appendChild(webm);
  }

  if (isUsablePath(config.video)) {
    const mp4 = document.createElement('source');
    mp4.src = config.video.trim();
    mp4.type = 'video/mp4';
    video.appendChild(mp4);
  }

  return video;
}

/**
 * Инициализирует видео-фон.
 *
 * Вызывается один раз при загрузке страницы. Если видео не нужно, в DOM
 * ничего не добавляется — остаётся статичная подложка из CSS.
 *
 * @returns {void}
 */
export function init() {
  const hero = $('#hero');
  if (!hero) {
    return;
  }

  const config = settings();

  // Подложка-постер ставится ВСЕГДА, даже когда видео выключено: на
  // медленном канале это единственное, что посетитель увидит на первом
  // экране, и пустой чёрный прямоугольник вместо него — плохая встреча.
  const layer = document.createElement('div');
  layer.className = 'hero__media';
  layer.setAttribute('aria-hidden', 'true');
  hero.insertBefore(layer, hero.firstChild);
  setPoster(layer, config.posterMobile, config.poster);

  // Постер выбирается по ширине экрана, а ширина меняется: поворот
  // телефона, окно на компьютере. Без этого обработчика вертикальный
  // постер оставался бы на широком экране и наоборот — растянутый кроп
  // с обрезанными краями. Слушатель висит на весь жизненный цикл
  // страницы: их всего один, утечки нет.
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    const query = window.matchMedia('(max-width: 720px)');
    const onResize = () => setPoster(layer, config.posterMobile, config.poster);
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onResize);
    } else if (typeof query.addListener === 'function') {
      // Safari < 14 — только устаревший API.
      query.addListener(onResize);
    }
  }

  if (config.enabled === false) {
    console.info('[crystal] hero-video: видео выключено в CONFIG.background.enabled');
    return;
  }

  if (prefersReducedMotion()) {
    console.info('[crystal] hero-video: у посетителя включено «уменьшить движение» — оставляем постер');
    return;
  }

  if (prefersReducedData()) {
    console.info('[crystal] hero-video: включена экономия трафика — оставляем постер');
    return;
  }

  if (!isUsablePath(config.video) && !isUsablePath(config.videoWebm)) {
    console.warn('[crystal] hero-video: пути к видео не заданы, показываем постер');
    return;
  }

  const video = buildVideo(config);

  // Класс is-playing вешаем по событию, а не сразу: до первого кадра
  // видео прозрачное, и если показать его раньше времени, под текстом
  // мелькнёт пустота. Плавное появление делает именно CSS по этому классу.
  video.addEventListener('playing', () => {
    layer.classList.add(PLAYING_CLASS);
    // Постер под работающим видео — лишний декодированный кадр
    // 1600×900 в памяти. Пока видео не играет, он нужен как подложка,
    // но после старта его можно снять: сам <video> уже непрозрачен.
    layer.style.backgroundImage = '';
  }, { once: true });

  // Ошибка загрузки — не повод показывать битую рамку. Постер остаётся,
  // в консоль уходит понятное объяснение.
  video.addEventListener('error', () => {
    console.warn('[crystal] hero-video: видео не загрузилось, остаётся постер');
    video.remove();
    layer.classList.remove(PLAYING_CLASS);
  }, { once: true });

  layer.appendChild(video);

  // Что именно скачает браузер, заранее неизвестно: он сам выбирает
  // первый поддерживаемый <source>. Для диагностики смотрим на
  // currentSrc уже ПОСЛЕ начала загрузки — там стоит реальный адрес.
  video.addEventListener('loadeddata', () => {
    const actual = video.currentSrc || '';
    const kind = actual.endsWith('.webm') ? 'WebM/VP9' : 'MP4/h264';
    console.info(`[crystal] hero-video: выбран источник ${kind} — ${actual}`);
  }, { once: true });

  video.play().catch((error) => {
    // Сюда попадаем, если браузер всё-таки запретил автовоспроизведение
    // (например, в режиме энергосбережения). Это не поломка: постер под
    // видео выглядит ровно так же, поэтому просто фиксируем в консоли.
    console.info('[crystal] hero-video: автовоспроизведение отложено браузером', error);
    layer.classList.remove(PLAYING_CLASS);
  });
}
