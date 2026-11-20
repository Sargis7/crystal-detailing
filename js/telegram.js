/**
 * Отправка заявок в Telegram.
 *
 * Модуль вынесен из form.js, потому что транспорт — независимая от интерфейса
 * сущность: его можно переиспользовать и тестировать без DOM. Здесь же
 * сосредоточен главный риск проекта — утечка токена бота.
 *
 * ⚠️ РЕЖИМЫ РАБОТЫ
 *   'direct' — браузер обращается к api.telegram.org напрямую. Работает сразу,
 *              но токен бота виден любому посетителю в инструментах разработчика.
 *              Допустим только для демонстрации и приёмки.
 *   'proxy'  — сайт обращается к вашей serverless-функции, а та — к Bot API.
 *              Токен остаётся на сервере. Рекомендуется для продакшена.
 *
 * Переключение — одна строка в js/config.js. Подробности — в README.md.
 *
 * @module js/telegram
 */

import CONFIG, { isPlaceholder, isBranchReady, normalizeBranch } from './config.js';

/**
 * @typedef {Object} CalcContext
 * @property {string} vin Нормализованный VIN.
 * @property {string|null} make Марка.
 * @property {string|null} model Модель.
 * @property {number|null} year Год выпуска.
 * @property {number} carClass Класс 1–5.
 * @property {string} serviceId Выбранная услуга.
 * @property {number} priceLow Нижняя граница цены.
 * @property {number} priceHigh Верхняя граница цены.
 */

/**
 * @typedef {Object} LeadPayload
 * @property {'ru'|'am'} branch Филиал — определяет целевой чат.
 * @property {string} name Имя клиента.
 * @property {string} phone Телефон в формате +7… или +374…
 * @property {string} model Модель автомобиля.
 * @property {string} comment Комментарий.
 * @property {boolean} consent Согласие на обработку данных.
 * @property {'ru'|'hy'} lang Язык сайта в момент отправки.
 * @property {string} pageUrl Адрес страницы.
 * @property {string} iso8601 Время отправки в UTC.
 * @property {CalcContext|null} calc Данные расчёта, если он выполнялся.
 */

/**
 * @typedef {Object} SendResult
 * @property {boolean} ok Успешно ли отправлено.
 * @property {'sent'|'not_configured'|'network'|'api_error'|'timeout'|'unknown_branch'} status Код результата.
 * @property {'ru'|'am'} targetBranch Целевой филиал.
 * @property {string} targetChatId Идентификатор чата; пустая строка, если не настроен.
 * @property {string} transport Использованный транспорт.
 * @property {string} [detail] Текстовое описание ошибки от сервиса.
 */

/**
 * @typedef {Object} MessageTransport
 * @property {string} name Имя транспорта.
 * @property {(chatId: string, text: string) => Promise<SendResult>} send Отправка сообщения.
 */

/**
 * Транспорт прямой отправки: браузер → api.telegram.org → чат.
 * Токен присутствует в запросе и виден клиенту — см. предупреждение в шапке файла.
 *
 * @returns {MessageTransport} Транспорт прямой отправки.
 */
export function createDirectTransport() {
  return {
    name: 'direct',

    /**
     * @param {string} chatId Идентификатор чата.
     * @param {string} text Текст сообщения.
     * @returns {Promise<SendResult>} Результат отправки.
     */
    async send(chatId, text) {
      const token = CONFIG.telegram.botToken;
      const base = CONFIG.telegram.apiBase || 'https://api.telegram.org';
      const endpoint = `${base}/bot${token}/sendMessage`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.telegram.timeoutMs || 10000);

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
          signal: controller.signal,
        });

        const payload = await safeJson(response);

        if (!response.ok || !payload || payload.ok !== true) {
          return {
            ok: false,
            status: 'api_error',
            targetBranch: 'ru',
            targetChatId: chatId,
            transport: 'direct',
            detail: describeTelegramError(response, payload),
          };
        }

        return { ok: true, status: 'sent', targetBranch: 'ru', targetChatId: chatId, transport: 'direct' };
      } catch (error) {
        const isAbort = error && error.name === 'AbortError';
        return {
          ok: false,
          status: isAbort ? 'timeout' : 'network',
          targetBranch: 'ru',
          targetChatId: chatId,
          transport: 'direct',
          detail: isAbort ? 'превышено время ожидания' : String(error && error.message ? error.message : error),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Транспорт через serverless-функцию: токен в клиент не попадает.
 * Функция принимает { branch, text } и сама подставляет chat_id и токен.
 *
 * @returns {MessageTransport} Транспорт прокси.
 */
export function createProxyTransport() {
  return {
    name: 'proxy',

    /**
     * @param {string} chatId Идентификатор чата (передаётся для совместимости).
     * @param {string} text Текст сообщения.
     * @param {'ru'|'am'} [branch='ru'] Филиал — прокси сам выбирает чат.
     * @returns {Promise<SendResult>} Результат отправки.
     */
    async send(chatId, text, branch = 'ru') {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.telegram.timeoutMs || 10000);

      try {
        const response = await fetch(CONFIG.telegram.proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branch, chatId, text }),
          signal: controller.signal,
        });

        const payload = await safeJson(response);

        if (!response.ok || !payload || payload.ok !== true) {
          return {
            ok: false,
            status: 'api_error',
            targetBranch: branch,
            targetChatId: chatId,
            transport: 'proxy',
            detail: describeTelegramError(response, payload),
          };
        }

        return { ok: true, status: 'sent', targetBranch: branch, targetChatId: chatId, transport: 'proxy' };
      } catch (error) {
        const isAbort = error && error.name === 'AbortError';
        return {
          ok: false,
          status: isAbort ? 'timeout' : 'network',
          targetBranch: branch,
          targetChatId: chatId,
          transport: 'proxy',
          detail: isAbort ? 'превышено время ожидания' : String(error && error.message ? error.message : error),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Безопасный разбор тела ответа: сервис может вернуть не-JSON
 * (например, HTML-страницу ошибки шлюза).
 *
 * @param {Response} response Ответ fetch.
 * @returns {Promise<Object|null>} Разобранный объект либо null.
 */
async function safeJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

/**
 * Формирует понятное описание ошибки Telegram API.
 *
 * @param {Response} response Ответ fetch.
 * @param {Object|null} payload Разобранное тело.
 * @returns {string} Описание ошибки.
 */
function describeTelegramError(response, payload) {
  if (payload && payload.description) {
    return `${response.status}: ${payload.description}`;
  }
  return `HTTP ${response.status}`;
}

/**
 * Выбирает транспорт по настройке CONFIG.telegram.transport.
 *
 * Режим 'off' возвращает транспорт-заглушку, который ничего не отправляет
 * и честно сообщает 'not_configured'. Нужен он для одной цели: если
 * sendLead когда-нибудь вызовется в обход проверки готовности, запрос
 * всё равно не уйдёт — а не уйдёт он в api.telegram.org с пустым токеном,
 * где превратился бы в 404 и непонятную ошибку в консоли.
 *
 * @returns {MessageTransport} Активный транспорт.
 */
export function getTransport() {
  const mode = CONFIG.telegram.transport;

  if (mode === 'off') {
    return {
      name: 'off',
      async send(chatId, text, branch = 'ru') {
        return {
          ok: false,
          status: 'not_configured',
          targetBranch: branch,
          targetChatId: chatId || '',
          transport: 'off',
          detail: 'telegram.transport = off',
        };
      },
    };
  }

  if (mode === 'proxy') {
    if (isPlaceholder(CONFIG.telegram.proxyUrl)) {
      console.warn('[crystal] telegram: выбран режим "proxy", но CONFIG.telegram.proxyUrl не заполнен.');
    }
    return createProxyTransport();
  }

  if (!isPlaceholder(CONFIG.telegram.botToken)) {
    console.warn(
      '[crystal] telegram: ⚠️ РЕЖИМ direct — токен бота виден любому посетителю сайта. ' +
      'Перед публикацией переведите CONFIG.telegram.transport в "proxy" и разверните serverless-функцию. ' +
      'Инструкция — в разделе «Безопасность» файла README.md.'
    );
  }

  return createDirectTransport();
}

/**
 * Формирует текст заявки для менеджера.
 *
 * ВАЖНО: текст отправляется без parse_mode, поэтому пользовательские данные
 * (имя, комментарий) не могут внедрить разметку в сообщение Telegram.
 *
 * @param {LeadPayload} payload Данные заявки.
 * @returns {string} Готовый текст сообщения.
 */
export function buildMessage(payload) {
  // Тот же защитный приём, что и в sendLead: buildMessage — публичная
  // функция модуля, её вызывают тесты и резервный канал, и падать на
  // null входа она не должна.
  const lead = (payload && typeof payload === 'object') ? payload : {};
  const branch = normalizeBranch(lead.branch);
  const branchLabel = branch === 'am' ? 'Армения (Ереван)' : 'Россия (Липецк)';
  const langLabel = lead.lang === 'hy' ? 'армянский (hy)' : 'русский (ru)';

  const lines = [
    '🔷 НОВАЯ ЗАЯВКА — CRYSTAL',
    '─────────────────────',
    `Регион: ${branchLabel}`,
    `Имя: ${lead.name || '—'}`,
    `Телефон: ${lead.phone || '—'}`,
    `Модель: ${lead.model || '—'}`,
  ];

  if (lead.calc) {
    const calc = lead.calc;
    lines.push(`VIN: ${calc.vin || '—'}`);
    lines.push(`Класс авто: ${calc.carClass || '—'}`);
    if (calc.make || calc.model) {
      lines.push(`Распознано: ${[calc.make, calc.model].filter(Boolean).join(' ')}`);
    }
    if (calc.year) {
      lines.push(`Год выпуска: ${calc.year}`);
    }
    if (calc.priceLow && calc.priceHigh) {
      lines.push(`Ориентир цены: ${formatMoney(calc.priceLow)} — ${formatMoney(calc.priceHigh)} ₽`);
    }
    lines.push(`Услуга: ${serviceLabel(calc.serviceId, lead.lang)}`);
  } else {
    lines.push('Услуга: —');
  }

  if (lead.comment) {
    lines.push(`Комментарий: ${lead.comment}`);
  }

  lines.push('─────────────────────');
  lines.push(`Согласие на обработку ПД: ${lead.consent ? 'получено' : 'НЕ ПОЛУЧЕНО'}`);
  lines.push(`Язык сайта: ${langLabel}`);
  lines.push(`Страница: ${lead.pageUrl || '—'}`);
  lines.push(`Время (UTC): ${lead.iso8601 || new Date().toISOString()}`);

  return lines.join('\n');
}

/**
 * Форматирует сумму с разделителями разрядов.
 *
 * @param {number} value Сумма.
 * @returns {string} Отформатированная строка.
 */
function formatMoney(value) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(value) || 0);
}

/**
 * Возвращает читаемое название услуги для сообщения менеджеру.
 * Названия продублированы здесь намеренно: менеджер должен видеть услугу
 * на русском независимо от языка, выбранного посетителем.
 *
 * @param {string} serviceId Идентификатор услуги.
 * @param {'ru'|'hy'} [lang='ru'] Язык посетителя — добавляется второй строкой.
 * @returns {string} Название услуги.
 */
function serviceLabel(serviceId, lang = 'ru') {
  const names = {
    'complex-wash': 'Комплексная детейлинг-мойка',
    'engine-bay': 'Детейлинг подкапотного пространства',
    antichrome: 'Антихром',
    polish: 'Полировка кузова',
  };
  const hyNames = {
    'complex-wash': 'Համալիր դեթեյլինգ-լվացում',
    'engine-bay': 'Շարժիչի հատվածի դեթեյլինգ',
    antichrome: 'Անտիքրոմ',
    polish: 'Թափքի պոլիրովկա',
  };
  const base = names[serviceId] || serviceId || '—';
  if (lang === 'hy' && hyNames[serviceId]) {
    return `${base} (${hyNames[serviceId]})`;
  }
  return base;
}

/**
 * Главный вход для формы. Сам определяет целевой чат по payload.branch.
 *
 * Гарантии:
 *  — никогда не бросает исключений;
 *  — при незаполненном конфиге НЕ выполняет сетевой запрос,
 *    а возвращает status 'not_configured' (данные посетителя не теряются);
 *  — пишет в консоль, в какой чат ушла бы заявка, если включён debugLogRouting.
 *
 * @param {LeadPayload} payload Данные заявки.
 * @returns {Promise<SendResult>} Результат отправки.
 */
export async function sendLead(payload) {
  // Приводим вход к объекту один раз в начале. До этого здесь стояло
  // `payload && payload.branch`, и этого хватало ровно до тех пор, пока
  // транспорт не начинал реально отправлять: при 'off' до buildMessage
  // дело не доходило, а на боевом режиме sendLead(null) падал на
  // `payload.branch` внутри buildMessage. Функция обещает «никогда не
  // бросает исключение», поэтому мусор на входе гасим здесь.
  const lead = (payload && typeof payload === 'object') ? payload : {};

  const branch = normalizeBranch(lead.branch);
  const transport = getTransport();

  const chatConfig = CONFIG.telegram.chats[branch];
  const chatId = chatConfig && !isPlaceholder(chatConfig.chatId) ? chatConfig.chatId : '';

  const readiness = isBranchReady(branch);

  if (CONFIG.telegram.debugLogRouting) {
    console.info(
      `[crystal] lead → branch=${branch}, chat=${chatId || '(не настроен)'}, transport=${transport.name}, ` +
      `ready=${readiness.ok}`
    );
    if (!readiness.ok) {
      console.info(`[crystal] lead → не заполнено: ${readiness.missing.join(', ')}`);
    }
  }

  if (!readiness.ok || !chatId) {
    return {
      ok: false,
      status: 'not_configured',
      targetBranch: branch,
      targetChatId: '',
      transport: transport.name,
      detail: `не заполнено: ${readiness.missing.join(', ')}`,
    };
  }

  // Филиал передаём явно: buildMessage нормализует регион тем же
  // правилом, что и маршрутизация, поэтому подпись «Регион:» в тексте
  // не может разойтись с чатом, куда ушло сообщение.
  const text = buildMessage({ ...lead, branch });
  const result = await transport.send(chatId, text, branch);

  // Транспорт не знает о филиале для прямого режима — исправляем после ответа.
  return { ...result, targetBranch: branch, targetChatId: chatId };
}

/**
 * Резервный канал отправки заявки, если Telegram недоступен.
 * Если адрес резервного сервиса не заполнен — ничего не делает.
 *
 * @param {LeadPayload} payload Данные заявки.
 * @returns {Promise<boolean>} true, если заявка продублирована.
 */
export async function sendFallback(payload) {
  if (isPlaceholder(CONFIG.telegram.emailEndpoint) || isPlaceholder(CONFIG.telegram.fallbackEmail)) {
    return false;
  }

  const lead = (payload && typeof payload === 'object') ? payload : {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.telegram.timeoutMs || 10000);

  try {
    const response = await fetch(CONFIG.telegram.emailEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: CONFIG.telegram.fallbackEmail,
        subject: `Заявка с сайта Crystal — ${normalizeBranch(lead.branch) === 'am' ? 'Армения (Ереван)' : 'Россия (Липецк)'}`,
        text: buildMessage(lead),
      }),
      signal: controller.signal,
    });
    return response.ok;
  } catch (error) {
    console.warn('[crystal] telegram: резервный канал недоступен:', error.message || error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export default { createDirectTransport, createProxyTransport, getTransport, sendLead, buildMessage, sendFallback };
