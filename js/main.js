/**
 * ТОЧКА ВХОДА САЙТА CRYSTAL.
 *
 * Это единственный модуль, подключённый тегом <script type="module">.
 * Все остальные зависимости подтягиваются статическими import — ES-модули
 * сами разрешают граф, поэтому второго тега script быть не должно: он
 * привёл бы к двойной инициализации обработчиков.
 *
 * ПОРЯДОК ЗАПУСКА ЗАДАН НАМЕРЕННО И МЕНЯТЬ ЕГО НЕЛЬЗЯ:
 *
 *  1. store.init()            — проверяет доступность localStorage.
 *  2. i18n.init()             — СИНХРОННО применяет язык к уже разобранному
 *                               HTML. Инлайн-скрипт в <head> выставил
 *                               атрибут lang до первой отрисовки, но сами
 *                               тексты ещё русские; здесь они заменяются
 *                               до того, как браузер успеет показать
 *                               неверный язык.
 *  3. nav / ui / gallery      — поведение, не зависящее от данных.
 *  4. calculator / form       — зависят от CONFIG и от i18n.
 *  5. cookie                  — последним из интерфейсных модулей, чтобы
 *                               баннер не перекрывал ещё не построенную
 *                               страницу и чтобы аналитика не успела
 *                               подключиться раньше проверки согласия.
 *  6. аналитика               — только через loadAnalyticsIfAllowed().
 *
 * Ошибка в одном модуле не должна ронять остальные: каждый блок обёрнут
 * в try/catch, а сбой пишется в консоль с пометкой [crystal]. Посетитель
 * в худшем случае останется без одной функции, а не без всего сайта.
 *
 * @module js/main
 */

import { CONFIG, listPlaceholders } from './config.js';
import * as store from './core/store.js';
import * as i18n from './core/i18n.js';
import * as nav from './nav.js';
import * as ui from './ui.js';
import * as gallery from './gallery.js';
import * as pricelist from './pricelist.js';
import * as heroVideo from './hero-video.js';
import { validateBaseConfig, getContent } from './core/content.js';
import * as remote from './core/remote.js';
import * as calculator from './calculator.js';
import * as form from './form.js';
import * as cookie from './cookie.js';

/**
 * Публикует код языка в window — его читает инлайн-скрипт в index.html
 * и модуль ui.js, чтобы держать атрибут data-lang в согласии с реальным
 * языком страницы.
 *
 * @param {string} lang Код языка.
 * @returns {void}
 */
function publishLanguage(lang) {
  try {
    window.__CRYSTAL_LANG = lang;
    document.documentElement.setAttribute('data-lang', lang);
  } catch (error) {
    console.warn('[crystal] main: не удалось опубликовать язык', error);
  }
}

/**
 * Применяет значения из CONFIG к разметке.
 *
 * Разметка носит значения, скопированные из конфига вручную (телефон,
 * адрес, ссылки на соцсети). Такой дубль рано или поздно разойдётся, поэтому
 * источником правды объявляется CONFIG, а HTML остаётся лишь запасным
 * вариантом для случая, когда JavaScript не выполнился вовсе.
 *
 * @returns {void}
 */
function applyConfigToDom() {
  // data-config-text="branches.ru.phone" → текст элемента.
  document.querySelectorAll('[data-config-text]').forEach((node) => {
    const path = node.getAttribute('data-config-text');
    // Армянская версия адреса. Поле addressHy существует только у
    // ереванского филиала: у Липецка российский адрес и в hy остаётся
    // русским, поэтому отсутствие поля — норма, а не ошибка.
    const localized = i18n.getLanguage() === 'hy' && path.endsWith('.address')
      ? resolveConfigPath(path.replace(/\.address$/, '.addressHy'))
      : null;
    if (typeof localized === 'string' && localized.trim() && !isPlaceholderValue(localized)) {
      node.textContent = localized;
      return;
    }
    const value = resolveConfigPath(path);
    if (typeof value === 'string' && value.trim() && !isPlaceholderValue(value)) {
      node.textContent = value;
    }
  });

  // data-config-primary-phone-text → текст телефона основного филиала.
  //
  // Отдельное правило, а не data-config-text: тот требует жёсткого пути
  // вида branches.ru.phone, а телефон в шапке обязан следовать за
  // primaryBranch. Пока правило было привязано к Липецку, шапка показывала
  // российский номер при основном филиале Ереван.
  document.querySelectorAll('[data-config-primary-phone-text]').forEach((node) => {
    const primary = resolveConfigPath(`branches.${data().primaryBranch}.phone`);
    if (typeof primary === 'string' && primary.trim() && !isPlaceholderValue(primary)) {
      node.textContent = primary;
    }
  });

  // data-config-href → href у ссылки; tel: собирается из phoneRaw.
  document.querySelectorAll('[data-config-href]').forEach((node) => {
    const path = node.getAttribute('data-config-href');
    const branchId = path.startsWith('branches.') ? path.split('.')[1] : '';
    const isPhone = path.endsWith('phoneRaw');
    /**
     * Путь может указывать не на телефон и не на адрес, а на строку,
     * которой нужна своя схема: `legal.operatorAm.email` → mailto:.
     * Без этого правила ссылка «написать письмо» вела бы на голый адрес
     * без схемы, и браузер считал бы его относительным путём на сайте.
     */
    const isEmail = path.endsWith('.email');

    // Ссылка может быть привязана к ОСНОВНОМУ филиалу, а не к тому, чей
    // путь прописан в разметке. Так кнопка «Позвонить» на первом экране
    // следует за основным филиалом: поменяли primaryBranch — номер
    // сменился сам, править разметку не нужно.
    //
    // Условие НЕ должно требовать branchId !== primaryBranch: в разметке
    // указан just тот же филиал, что и основной, и такая проверка молча
    // отключала бы логику, подставляя номер из разметки (Липецк) на
    // кнопку, которая обещает звонок в Ереван. Флаг в HTML — достаточное
    // основание.
    const followsPrimary = isPhone && node.hasAttribute('data-config-follow-primary');

    const value = followsPrimary
      ? resolveConfigPath(`branches.${data().primaryBranch}.phoneRaw`)
      : resolveConfigPath(path);

    // Номер берём у основного филиала. Если он ещё не заполнен (телефон
    // Еревана заказчик пока не дал), кнопка честно гасится: звонок в
    // Липецк с ереванской кнопки был бы обманом посетителя.
    if (followsPrimary) {
      if (typeof value !== 'string' || !value.trim() || isPlaceholderValue(value)) {
        node.setAttribute('href', '#');
        node.setAttribute('aria-disabled', 'true');
        return;
      }
      node.setAttribute('href', `tel:${value}`);
      node.removeAttribute('aria-disabled');
      return;
    }

    if (typeof value !== 'string' || !value.trim() || isPlaceholderValue(value)) {
      // Ссылка без адреса ведёт в никуда — лучше сделать её неактивной,
      // чем отправить посетителя на «#» с ощущением поломки.
      node.setAttribute('href', '#');
      node.setAttribute('aria-disabled', 'true');
      // data-placeholder-note: пока адреса нет, подпись «Как добраться»
      // была бы обещанием, которого ссылка не выполняет. Пишем вместо неё
      // честную пометку — на языке страницы.
      if (node.hasAttribute('data-placeholder-note') && i18n.has('contacts.toBeConfirmed')) {
        node.textContent = i18n.t('contacts.toBeConfirmed');
      }
      return;
    }
    if (isEmail) {
      node.setAttribute('href', `mailto:${value}`);
    } else {
      node.setAttribute('href', isPhone ? `tel:${value}` : value);
    }
    node.removeAttribute('aria-disabled');
  });

  // Текст-заглушка на месте незаполненных данных (например, телефон
  // ереванского филиала). Ключ берётся из словаря, поэтому фраза звучит на
  // языке страницы, а не остаётся русской. Если перевода нет — в разметке
  // уже лежит русский вариант, и он честно останется.
  document.querySelectorAll('[data-i18n-fallback]').forEach((node) => {
    const key = node.getAttribute('data-i18n-fallback');
    if (i18n.has(key)) {
      node.textContent = i18n.t(key);
    }
  });

  // data-config-src → src у картинки (логотип, OG-изображение в разметке).
  document.querySelectorAll('[data-config-src]').forEach((node) => {
    const value = resolveConfigPath(node.getAttribute('data-config-src'));
    if (typeof value === 'string' && value.trim() && !isPlaceholderValue(value)) {
      node.setAttribute('src', value);
    }
  });

  // data-config-city — только город, без улицы.
  document.querySelectorAll('[data-config-city]').forEach((node) => {
    const value = resolveConfigPath(node.getAttribute('data-config-city'));
    if (typeof value === 'string' && value.trim() && !isPlaceholderValue(value)) {
      node.setAttribute('data-city', value);
    }
  });

  // Соцсети и мессенджеры. Незаполненная ссылка — это честно помеченная
  // неактивная кнопка, а не переход на пустую страницу.
  document.querySelectorAll('[data-social-link]').forEach((node) => {
    const network = node.getAttribute('data-social-link');
    const value = CONFIG.social ? CONFIG.social[network] : null;
    if (typeof value === 'string' && value.trim() && !isPlaceholderValue(value)) {
      node.setAttribute('href', value);
      node.removeAttribute('hidden');
      node.classList.remove('is-disabled');
      return;
    }
    node.setAttribute('href', '#');
    node.setAttribute('aria-disabled', 'true');
    node.classList.add('is-disabled');
    // Плавающая кнопка WhatsApp при незаполненной ссылке не нужна вовсе:
    // она перекрывает контент на мобильных.
    if (node.hasAttribute('data-fab')) {
      node.hidden = true;
    }
    // Внутри крупных кнопок подпись «Ссылка уточняется» уже стоит в HTML,
    // поэтому ничего не переписываем — только помечаем состояние.
  });

  // Canonical, OG и hreflang требуют АБСОЛЮТНОГО адреса. Пока
  // CONFIG.brand.siteUrl не заполнен, оставляем относительный canonical из
  // разметки: подставить туда «[ЗАПОЛНИТЬ]» или собрать ссылку из
  // location.origin нельзя — на локальном сервере это дало бы
  // http://127.0.0.1:8000/, и поисковик запомнил бы адрес машины
  // разработчика как канонический.
  applyCanonicalUrls();
}

/**
 * Проставляет абсолютные адреса в canonical, og:url и hreflang.
 *
 * Без заполненного CONFIG.brand.siteUrl функция ничего не делает — это
 * единственный корректный вариант: выдуманный адрес хуже отсутствующего.
 *
 * @returns {void}
 */
function applyCanonicalUrls() {
  const siteUrl = CONFIG.brand ? CONFIG.brand.siteUrl : null;
  if (typeof siteUrl !== 'string' || !siteUrl.trim() || isPlaceholderValue(siteUrl)) {
    return;
  }

  // Убираем хвостовой слэш, чтобы не получить «example.com//legal/…».
  const base = siteUrl.trim().replace(/\/+$/, '');

  /**
   * Адрес текущей страницы внутри сайта — БЕЗ ведущего слэша.
   *
   * '/legal/privacy-ru.html' → 'legal/privacy-ru.html'
   * '/'                      → ''            (главная)
   * '/index.html'            → ''            (главная)
   *
   * Ведущий слэш снимаем обязательно: склейка `${base}/${relative}` при
   * относительном пути с ведущим слэшем даёт двойной слэш — часть
   * поисковиков считает такой адрес отдельной страницей и canonical
   * начинает работать против нас.
   *
   * @returns {string} Относительный путь без ведущего слэша.
   */
  const currentPath = () => {
    const path = window.location.pathname || '/';

    // Каталог вместо файла: '/legal/' означает '/legal/index.html'.
    if (path.endsWith('/')) {
      return path === '/' ? '' : path.replace(/^\/+|\/+$/g, '');
    }
    // Явный index.html в любом каталоге — это тот же адрес, что и каталог.
    if (/\/index\.html$/.test(path)) {
      return path.replace(/\/index\.html$/, '').replace(/^\/+/, '');
    }
    return path.replace(/^\/+/, '');
  };

  /**
   * Собирает абсолютный адрес из базы и относительного пути.
   *
   * @param {string} path Относительный путь без ведущего слэша ('' — главная).
   * @returns {string} Абсолютный адрес.
   */
  const absolute = (path) => (path ? `${base}/${path}` : `${base}/`);

  const relative = currentPath();

  document.querySelectorAll('link[rel="canonical"]').forEach((node) => {
    // data-canonical-path="" на главной — это осознанный «пустой путь»,
    // а не отсутствие значения, поэтому проверяем на null, а не на truthy.
    const own = node.getAttribute('data-canonical-path');
    node.setAttribute('href', absolute(own === null ? relative : own));
  });

  document.querySelectorAll('meta[property="og:url"]').forEach((node) => {
    node.setAttribute('content', absolute(relative));
  });

  document.querySelectorAll('link[rel="alternate"][hreflang]').forEach((node) => {
    const lang = node.getAttribute('hreflang');
    const own = node.getAttribute('data-canonical-path');
    // ?lang=ru избыточен: русский — язык по умолчанию, и лишний параметр
    // раздваивает адрес одной и той же страницы в глазах поисковика.
    const suffix = lang && lang !== 'ru' ? `?lang=${lang}` : '';
    node.setAttribute('href', `${absolute(own === null ? relative : own)}${suffix}`);
  });
}

/**
 * Конфиг с учётом правок из админ-панели.
 *
 * CONFIG — статический объект модуля, а админка пишет дельту в
 * localStorage. Читай мы CONFIG напрямую, правки филиалов (адрес,
 * телефон) не доходили бы до контактов на странице. Ошибка чтения не
 * должна ломать рендер — откатываемся на базовый CONFIG.
 *
 * @returns {Object} Слитый конфиг.
 */
function data() {
  try {
    return getContent();
  } catch (error) {
    console.warn('[crystal] main: не удалось прочитать правки, работаем с CONFIG', error);
    return CONFIG;
  }
}

/**
 * Читает значение из конфига с правками по пути 'branches.ru.phone'.
 *
 * @param {string|null} path Путь через точку.
 * @returns {*} Значение или null.
 */
function resolveConfigPath(path) {
  if (!path) {
    return null;
  }
  return path.split('.').reduce((node, key) => (node ? node[key] : null), data());
}

/**
 * Проверяет, что значение не является заглушкой '[ЗАПОЛНИТЬ]'.
 *
 * @param {*} value Значение.
 * @returns {boolean} true, если значение не заполнено.
 */
function isPlaceholderValue(value) {
  if (value === null || value === undefined) {
    return true;
  }
  const text = String(value).trim();
  return text === '' || text.includes('[ЗАПОЛНИТЬ]');
}

/**
 * Выводит в консоль чек-лист того, что заказчик ещё не заполнил.
 *
 * Это не ошибка: сайт умышленно работает с заглушками, чтобы заказчик мог
 * принять вёрстку до передачи реальных данных. Но список должен быть виден
 * в первой же строке консоли, иначе о нём забывают перед публикацией.
 *
 * @returns {void}
 */
function reportPlaceholders() {
  let missing = [];
  try {
    missing = listPlaceholders();
  } catch (error) {
    console.warn('[crystal] main: не удалось собрать список заглушек', error);
    return;
  }

  if (!missing.length) {
    console.info('[crystal] Конфигурация заполнена полностью.');
    return;
  }

  console.info(
    `[crystal] Не заполнено значений: ${missing.length}. ` +
    'Перед публикацией сайта замените все [ЗАПОЛНИТЬ] в js/config.js — список ниже.'
  );
  console.info(missing.join('\n'));
}

/**
 * Подключает аналитику, если посетитель дал согласие на необязательные cookie.
 *
 * Ни одного счётчика до согласия: это требование 152-ФЗ и Закона РА ЗР-49,
 * а не рекомендация. Поэтому загрузчик вставляется только из этой функции,
 * а не тегом в <head>.
 *
 * @returns {void}
 */
function setupAnalytics() {
  const loaded = cookie.loadAnalyticsIfAllowed(() => {
    const metrikaId = CONFIG.analytics ? CONFIG.analytics.yandexMetrikaId : null;
    const gaId = CONFIG.analytics ? CONFIG.analytics.googleAnalyticsId : null;

    if (typeof metrikaId === 'string' && metrikaId.trim() && !isPlaceholderValue(metrikaId)) {
      injectYandexMetrika(metrikaId);
    }
    if (typeof gaId === 'string' && gaId.trim() && !isPlaceholderValue(gaId)) {
      injectGoogleAnalytics(gaId);
    }
  });

  if (!loaded) {
    console.info('[crystal] Аналитика не подключена: нет согласия на необязательные cookie.');
  }
}

/**
 * Вставляет счётчик Яндекс.Метрики.
 *
 * @param {string} id Номер счётчика.
 * @returns {void}
 */
function injectYandexMetrika(id) {
  /* eslint-disable */
  (function (m, e, t, r, i, k, a) {
    m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
    m[i].l = 1 * new Date();
    for (let j = 0; j < document.scripts.length; j += 1) {
      if (document.scripts[j].src === r) { return; }
    }
    k = e.createElement(t); a = e.getElementsByTagName(t)[0];
    k.async = 1; k.src = r; a.parentNode.insertBefore(k, a);
  })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');
  /* eslint-enable */

  window.ym(Number(id) || id, 'init', {
    clickmap: true,
    trackLinks: true,
    accurateTrackBounce: true,
    webvisor: true,
  });
  console.info(`[crystal] Яндекс.Метрика подключена: ${id}`);
}

/**
 * Вставляет счётчик Google Analytics 4.
 *
 * @param {string} id Идентификатор потока вида G-XXXXXXX.
 * @returns {void}
 */
function injectGoogleAnalytics(id) {
  const tag = document.createElement('script');
  tag.async = true;
  tag.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.appendChild(tag);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', id);
  console.info(`[crystal] Google Analytics подключена: ${id}`);
}

/**
 * Включает и выключает блоки по CONFIG.features.
 *
 * Логика одна: элемент с data-feature="<имя>" виден тогда и только тогда,
 * когда CONFIG.features[<имя>] истинно. Скрытие — атрибут hidden, а не
 * display:none в стилях: так секция исчезает и для скринридера, и из
 * потока табуляции. Разметку при этом никто не удаляет — включение
 * обратно не требует переписывать HTML.
 *
 * Вызывается ДО инициализации модулей: скрытый калькулятор не должен
 * заниматься построением списков и вешать обработчики на форму, которую
 * посетитель всё равно не увидит.
 *
 * @returns {void}
 */
function applyFeatureFlags() {
  const features = (CONFIG && CONFIG.features) || {};
  document.querySelectorAll('[data-feature]').forEach((node) => {
    const name = node.getAttribute('data-feature');
    if (!name) {
      return;
    }
    const enabled = features[name] !== false;
    if (enabled) {
      node.removeAttribute('hidden');
    } else {
      node.setAttribute('hidden', '');
      // aria-hidden не нужен: hidden уже убирает элемент из дерева
      // доступности. Дублировать его — распространять одно и то же
      // состояние двумя механизмами, которые можно рассогласовать.
    }
  });
}

/**
 * Запускает модуль, не позволяя его сбою уронить инициализацию остальных.
 *
 * @param {string} name Имя модуля для сообщения в консоли.
 * @param {() => void} starter Функция инициализации.
 * @returns {void}
 */
function safeInit(name, starter) {
  try {
    starter();
  } catch (error) {
    console.error(`[crystal] Модуль «${name}» не запустился:`, error);
  }
}

/**
 * Точка входа.
 *
 * @returns {void}
 */
function boot() {
  // 1. Хранилище. Без него не работает ни язык, ни согласие на cookie.
  safeInit('store', () => store.init());

  // 1a. Правки с сервера (data/site-overrides.json) — ДО всего остального.
  //     Их коммитит админ-панель, и посетители должны видеть именно их,
  //     а не базовые значения из config.js. Пока файл не прочитан,
  //     load() асинхронный, поэтому order такой: сначала запрашиваем файл
  //     и сразу получаем промис, затем выполняем остальные синхронные
  //     шаги (они нужны для мгновенной отрисовки), а на самом промис
  //     подписываемся в конце boot() — см. блок «сервер → DOM» ниже.
  //     Конфиг мутируется ровно один раз, до того как промис разрешится,
  //     поэтому цикл «прочитать конфиг → подписаться» не дублируется.
  safeInit('remote content', () => remote.load(CONFIG));

  // 2. Язык — синхронно и до всего остального: иначе посетитель увидит
  //    русский текст и только потом армянский.
  let lang = 'ru';
  safeInit('i18n', () => {
    lang = i18n.init();
  });
  publishLanguage(lang);

  // 3. Значения из CONFIG в разметку — до инициализации модулей, чтобы те
  //    работали с уже подставленными телефонами и ссылками.
  safeInit('config → DOM', applyConfigToDom);

  // 3a. Скрыть/показать блоки по CONFIG.features — до инициализации
  //     модулей, чтобы скрытый калькулятор не строил свои списки.
  safeInit('features', applyFeatureFlags);
  safeInit('config schema', () => {
    const problems = validateBaseConfig();
    if (problems.length) {
      console.warn('[crystal] config.js не соответствует ожиданиям:', problems);
    }
  });

  // 4. Поведение, не зависящее от данных.
  //    Язык публикуем повторно перед ui: он задаёт формат чисел в карточках
  //    услуг (разделитель разрядов), а i18n.init() выше сообщил о смене
  //    языка раньше, чем это стало кому-то интересно.
  safeInit('nav', () => nav.init());
  publishLanguage(lang);
  safeInit('ui', () => ui.init());
  // Прайс-лист — после ui: он переиспользует режим цен и переводы, которые
  // ui готовит на старте. До calculator: строки прайса предзаполняют форму,
  // и селект услуги должен уже существовать.
  safeInit('pricelist', () => pricelist.init());
  safeInit('gallery', () => gallery.init());
  // Видео-фон — после ui и gallery: сам по себе он ничего не рисует,
  // но грузит самый тяжёлый файл страницы, поэтому пусть сначала
  // построится всё, что видно сразу, и только потом начнётся закачка.
  safeInit('hero-video', () => heroVideo.init());

  // 5. Модули, зависящие от CONFIG и i18n.
  //    Калькулятор инициализируется только если включён: он пишет
  //    обработчики на форму VIN, которой на странице может не быть.
  if (!CONFIG.features || CONFIG.features.vinCalculator !== false) {
    safeInit('calculator', () => calculator.init());
  }
  safeInit('form', () => form.init());

  // 6. Баннер cookie и только после него — аналитика.
  safeInit('cookie', () => cookie.init());
  safeInit('analytics', setupAnalytics);

  // 7. Диагностика для заказчика: что ещё нужно заполнить.
  safeInit('placeholders', reportPlaceholders);

  // 8. Правки из репозитория. Файл data/site-overrides.json запрашивается
  //    асинхронно, поэтому к моменту разрешения промиса страница уже
  //    отрисована на базовом config.js. Когда файл приходит, пересобираем
  //    то, что зависит от данных: цены и карточки услуг, прайс, карточки
  //    филиалов и ссылки на мессенджеры. Язык не трогаем — i18n.init()
  //    уже отработал, а словари от этого файла не зависят.
  //
  //    Модули, у которых есть своя функция отрисовки, вызываются через
  //    safeInit: сбой одного не должен оставить страницу в полуготовом виде.
  //    render() у прайса и renderServiceCards() у ui перерисовывают блоки
  //    целиком из данных, поэтому повторный вызов безопасен.
  remote.ready().then((result) => {
    if (!result.applied.length) {
      return;
    }
    safeInit('remote → DOM', applyConfigToDom);
    // initPriceMode (а не renderServiceCards): режим цен «по запросу» →
    // «фиксированные» меняет CSS-ветку карточек целиком, и без повторного
    // вызова атрибут на <html> остался бы прежним — суммы уже в DOM, а
    // стили всё ещё прячут их.
    safeInit('remote → price mode', () => ui.initPriceMode());
    safeInit('remote → ui', () => ui.renderServiceCards());
    safeInit('remote → pricelist', () => pricelist.render());
    document.dispatchEvent(new CustomEvent('crystal:remote-applied', { detail: { ...result } }));
  }).catch((error) => {
    console.warn('[crystal] main: правки с сервера не применились', error);
  });

  // Сообщаем всем, что страница готова: к этому моменту динамические блоки
  // отрисованы, и внешним скриптам (или e2e-тестам) есть за что зацепиться.
  document.documentElement.setAttribute('data-app-ready', 'true');
  document.dispatchEvent(new CustomEvent('crystal:ready', { detail: { lang } }));
  console.info('[crystal] Сайт инициализирован.');
}

// type="module" выполняется после разбора документа, поэтому DOM уже готов
// и обёртка над DOMContentLoaded не нужна. Проверка оставлена как страховка
// на случай, если файл когда-нибудь подключат обычным <script defer>.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
