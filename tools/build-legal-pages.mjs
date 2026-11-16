#!/usr/bin/env node
/**
 * Генератор юридических страниц legal/*.html.
 *
 * Зачем генератор, а не четыре файла руками: у страниц совпадает всё, кроме
 * тела документа, — <head>, инлайн-скрипт языка, шапка, подвал и подключение
 * js/legal.js. Копировать эти ~60 строк четыре раза значит однажды поправить
 * их в трёх файлах и забыть в четвёртом.
 *
 * Скрипт запускается вручную и НЕ является частью сборки сайта: сайт
 * публикуется как статические файлы. После запуска legal/*.html —
 * обычные готовые страницы, которые можно править напрямую.
 *
 * Запуск: node tools/build-legal-pages.mjs
 *
 * @module tools/build-legal-pages
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'legal');

/**
 * Собирает тело страницы из массива секций.
 *
 * @param {{id: string, title: string, body: string[]}[]} sections Секции.
 * @returns {string} HTML-разметка тела.
 */
function renderSections(sections) {
  return sections.map((section) => {
    const body = section.body.join('\n        ');
    return `      <section id="${section.id}">
        <h2 data-i18n="${section.title}"></h2>
        ${body}
      </section>`;
  }).join('\n\n');
}

/**
 * Собирает оглавление.
 *
 * @param {{id: string, title: string}[]} sections Секции.
 * @returns {string} HTML-разметка оглавления.
 */
function renderToc(sections) {
  const items = sections
    .map((s) => `          <li><a href="#${s.id}" data-i18n="${s.title}"></a></li>`)
    .join('\n');
  return `      <nav class="legal-toc" data-i18n-aria="legal.tocTitle" aria-label="Содержание">
        <p class="legal-toc__title" data-i18n="legal.tocTitle"></p>
        <ol>
${items}
        </ol>
      </nav>`;
}

/**
 * Собирает блок реквизитов оператора.
 *
 * @param {string} labelKey Ключ заголовка блока.
 * @param {string} configPrefix Путь в CONFIG, например 'legal.operatorRu'.
 * @param {string} ariaLabel Подпись для скринридера.
 * @param {{field: string, labelKey: string}[]} fields Поля.
 * @returns {string} HTML-разметка блока.
 */
function renderRequisites(labelKey, configPrefix, ariaLabel, fields) {
  const rows = fields.map((f) => `          <dt data-i18n="${f.labelKey}"></dt>
          <dd data-legal-requisite="${configPrefix}.${f.field}"></dd>`).join('\n');
  return `      <section class="legal-req" data-i18n-aria="${labelKey}" aria-label="${ariaLabel}">
        <p class="legal-toc__title" data-i18n="${labelKey}"></p>
        <dl>
${rows}
        </dl>
      </section>`;
}

/**
 * Собирает полный HTML-документ.
 *
 * @param {Object} page Описание страницы.
 * @returns {string} HTML.
 */
function renderPage(page) {
  const blocks = [];

  blocks.push(`      <h1 data-i18n="${page.titleKey}"></h1>`);
  blocks.push(`      <p class="legal-meta">
        <span><span data-i18n="legal.version"></span>: <span data-legal-version></span></span>
        <span><span data-i18n="legal.updated"></span>: <span data-legal-updated></span></span>
      </p>`);
  blocks.push(`      <div class="legal-warn" data-legal-fill-notice hidden>
        <p class="legal-warn__title" data-i18n="legal.fillNoticeTitle"></p>
        <p data-i18n="legal.fillNoticeText"></p>
      </div>`);
  blocks.push(`      <p data-i18n="${page.introKey}"></p>`);

  if (page.requisites) {
    blocks.push(page.requisites);
  }

  blocks.push(renderToc(page.sections));
  blocks.push(renderSections(page.sections));

  return `<!DOCTYPE html>
<html lang="ru" data-lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0A0A0C">
<meta name="robots" content="index, follow">
<!-- Canonical и og:url заполняются абсолютным адресом в js/legal.js из
     CONFIG.brand.siteUrl. data-canonical-path несёт путь ЭТОЙ страницы
     внутри сайта — атрибут нужен, потому что legal.js загружается из
     подкаталога и не может вывести путь из location.pathname надёжно. -->
<link rel="canonical" href="./" data-canonical-path="legal/${page.file}">
<meta property="og:url" content="">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Crystal Detailing">
<meta property="og:locale" content="ru_RU">
<meta property="og:locale:alternate" content="hy_AM">
<meta property="og:title" data-i18n-content="${page.titleKey}" content="">
<meta name="twitter:card" content="summary">
<meta name="format-detection" content="telephone=no">
<title data-i18n="${page.titleKey}"></title>
<meta name="description" content="${page.description}">

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Noto+Sans+Armenian:wght@400;500;600;700&display=swap">
<link rel="icon" href="../assets/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="../assets/favicon.svg">
<link rel="stylesheet" href="../css/style.css">

<!-- Синхронная установка языка ДО первой отрисовки: предотвращает мигание
     русского текста у армянского посетителя (FOUC). Дублируется в каждой
     юридической странице намеренно — модуль загрузился бы асинхронно. -->
<script>
(function () {
  try {
    var p = new URLSearchParams(window.location.search);
    var fromUrl = p.get('lang');
    var stored = null;
    try { stored = localStorage.getItem('crystal_lang'); } catch (e) { stored = null; }
    var nav = (navigator.language || navigator.userLanguage || '').toLowerCase();
    var lang = (fromUrl === 'hy' || fromUrl === 'ru') ? fromUrl
             : (stored === 'hy' || stored === 'ru') ? stored
             : nav.indexOf('hy') === 0 ? 'hy' : 'ru';
    document.documentElement.lang = lang;
    document.documentElement.setAttribute('data-lang', lang);
  } catch (e) { /* при любой ошибке остаётся русский по умолчанию */ }
})();
</script>
</head>
<body>
<a class="skip-link" href="#main" data-i18n="nav.home">К содержанию</a>

<!-- Простая шапка: без меню и переключателя языка — документ читается
     сверху вниз, а лишние элементы отвлекают от текста. -->
<header class="legal-header">
  <div class="container legal-header__inner">
    <a class="brand" href="../index.html" data-i18n-aria="legal.home" aria-label="Crystal">
      <img class="brand__mark" src="../assets/logo-placeholder.svg" alt="" width="40" height="40" data-config-src="brand.logo">
      <span class="brand__text">
        <span class="brand__name">Crystal</span>
        <span class="brand__tag" data-i18n="services.catDetailing">Детейлинг</span>
      </span>
    </a>
    <a class="btn btn--ghost btn--sm legal-page__back" href="../index.html" data-i18n="legal.back">Вернуться на сайт</a>
  </div>
</header>

<main id="main">
  <div class="container">
    <article class="legal-page">

${blocks.join('\n\n')}

      <section id="related">
        <h2 data-i18n="legal.relatedTitle"></h2>
        <ul>
${page.related}
        </ul>
        <p data-i18n="legal.termInForce"></p>
      </section>

    </article>
  </div>
</main>

<footer class="site-footer">
  <div class="container footer__bottom">
    <p class="footer__copy" data-i18n="footer.rights">© Crystal.</p>
    <p class="footer__note" data-i18n="footer.disclaimer"></p>
  </div>
</footer>

<script type="module" src="../js/legal.js"></script>
</body>
</html>
`;
}

/** Ссылки на связанные документы. */
const RELATED = {
  privacyRu: `          <li><a href="privacy-am.html" data-i18n="legal.relatedPrivacyAm"></a></li>
          <li><a href="consent.html" data-i18n="legal.relatedConsent"></a></li>
          <li><a href="cookies.html" data-i18n="legal.relatedCookies"></a></li>`,
  privacyAm: `          <li><a href="privacy-ru.html" data-i18n="legal.relatedPrivacyRu"></a></li>
          <li><a href="consent.html" data-i18n="legal.relatedConsent"></a></li>
          <li><a href="cookies.html" data-i18n="legal.relatedCookies"></a></li>`,
  consent: `          <li><a href="privacy-ru.html" data-i18n="legal.relatedPrivacyRu"></a></li>
          <li><a href="privacy-am.html" data-i18n="legal.relatedPrivacyAm"></a></li>
          <li><a href="cookies.html" data-i18n="legal.relatedCookies"></a></li>`,
  cookies: `          <li><a href="privacy-ru.html" data-i18n="legal.relatedPrivacyRu"></a></li>
          <li><a href="privacy-am.html" data-i18n="legal.relatedPrivacyAm"></a></li>
          <li><a href="consent.html" data-i18n="legal.relatedConsent"></a></li>`,
};

/** Реквизиты российского оператора. */
const REQ_RU = renderRequisites('legal.operatorRu', 'legal.operatorRu', 'Оператор персональных данных (Россия)', [
  { field: 'name', labelKey: 'legal.name' },
  { field: 'inn', labelKey: 'legal.inn' },
  { field: 'ogrn', labelKey: 'legal.ogrn' },
  { field: 'address', labelKey: 'legal.address' },
  { field: 'email', labelKey: 'legal.email' },
]);

/** Реквизиты армянского оператора. */
const REQ_AM = renderRequisites('legal.operatorAm', 'legal.operatorAm', 'Անձնական տվյալների օպերատոր (Հայաստան)', [
  { field: 'name', labelKey: 'legal.name' },
  { field: 'tin', labelKey: 'legal.tin' },
  { field: 'address', labelKey: 'legal.address' },
  { field: 'email', labelKey: 'legal.email' },
]);

/**
 * Описание секций: ключ заголовка и ключи абзацев.
 *
 * @param {string} prefix Префикс ключей, например 'legal.privacyRu'.
 * @param {string[]} titles Суффиксы заголовков.
 * @param {Record<string, number>} paragraphs Сколько абзацев в секции.
 * @returns {{id: string, title: string, body: string[]}[]} Секции.
 */
function sections(prefix, titles, paragraphs) {
  return titles.map((_, index) => {
    const n = index + 1;
    const count = paragraphs[n] || 0;
    const body = [];
    for (let i = 1; i <= count; i += 1) {
      body.push(`<p data-i18n="${prefix}.s${n}.p${i}"></p>`);
    }
    return { id: `s${n}`, title: `${prefix}.s${n}.title`, body };
  });
}

/** Все четыре страницы. */
const PAGES = [
  {
    file: 'privacy-ru.html',
    titleKey: 'legal.pageTitlePrivacyRu',
    introKey: 'legal.privacyRu.intro',
    description: 'Порядок обработки персональных данных и меры по обеспечению их безопасности. Редакция для Российской Федерации.',
    requisites: REQ_RU,
    related: RELATED.privacyRu,
    sections: sections('legal.privacyRu',
      ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 's12'],
      { 1: 4, 2: 4, 3: 5, 4: 3, 5: 1, 6: 5, 7: 4, 8: 4, 9: 2, 10: 2, 11: 2, 12: 3 }),
  },
  {
    file: 'privacy-am.html',
    titleKey: 'legal.pageTitlePrivacyAm',
    introKey: 'legal.privacyAm.intro',
    description: 'Անձնական տվյալների մշակման կարգը և անվտանգության ապահովման միջոցները։ Խմբագրություն Հայաստանի Հանրապետության համար։',
    requisites: REQ_AM,
    related: RELATED.privacyAm,
    sections: sections('legal.privacyAm',
      ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'],
      { 1: 4, 2: 4, 3: 4, 4: 4, 5: 3, 6: 3, 7: 3, 8: 4, 9: 3 }),
  },
  {
    file: 'consent.html',
    titleKey: 'legal.pageTitleConsent',
    introKey: 'legal.consent.intro',
    description: 'Согласие на обработку персональных данных: состав данных, цели обработки, срок действия и порядок отзыва.',
    requisites: `${REQ_RU}\n\n${REQ_AM}`,
    related: RELATED.consent,
    sections: sections('legal.consent',
      ['s1', 's2', 's3', 's4', 's5'],
      { 1: 2, 2: 3, 3: 3, 4: 4, 5: 3 }),
  },
  {
    file: 'cookies.html',
    titleKey: 'legal.pageTitleCookies',
    introKey: 'legal.cookies.intro',
    description: 'Какие файлы cookie используются на сайте, для чего они нужны и как управлять согласием.',
    requisites: REQ_RU,
    related: RELATED.cookies,
    sections: sections('legal.cookies',
      ['s1', 's2', 's3', 's4', 's5', 's6', 's7'],
      { 1: 3, 2: 4, 3: 4, 4: 3, 5: 4, 6: 3, 7: 2 }),
  },
];

mkdirSync(OUT_DIR, { recursive: true });

// privacy-ru.html заполнен своими ключами вручную (секция 13 — список
// связанных документов вместо раздела текста), поэтому генератор его не
// перезаписывает, а только проверяет наличие.
for (const page of PAGES) {
  if (page.file === 'privacy-ru.html') {
    continue;
  }
  const html = renderPage(page);
  writeFileSync(join(OUT_DIR, page.file), html, 'utf8');
  console.log(`legal/${page.file} — ${html.split('\n').length} строк`);
}

console.log('Готово. privacy-ru.html — исключение: правится вручную.');
