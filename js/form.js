/**
 * Форма обратной связи: валидация, маска телефона, отправка в Telegram.
 *
 * Ключевое требование (R-31, R-32): заявки из России и из Армении уходят
 * в РАЗНЫЕ Telegram-чаты. Регион — обязательный явный выбор пользователя,
 * он же определяет префикс телефона и текст подтверждения.
 *
 * Модуль не занимается сетевыми деталями — это делает js/telegram.js.
 * Здесь только: собрать корректный payload, вызвать отправку, показать статус.
 *
 * @module js/form
 */

import { $, on, setText } from './core/dom.js';
import { on as onBus, EVENTS } from './core/events.js';
import { t, getLanguage } from './core/i18n.js';
import { CONFIG, isPlaceholder, normalizeBranch } from './config.js';
import { sendLead, sendFallback } from './telegram.js';
import { getState as getCalcState } from './calculator.js';

/** Имя поля согласия в разметке. */
const CONSENT_FIELD = 'consent';

/** Класс активной кнопки в переключателе филиала (разметка .segmented). */
const BRANCH_ACTIVE_CLASS = 'is-active';

/**
 * Возвращает префикс телефона для региона.
 *
 * @param {'ru'|'am'} branch Регион.
 * @returns {string} Префикс, например '+7'.
 */
function phonePrefix(branch) {
  const config = CONFIG.branches[branch];
  return (config && config.phonePrefix) || (branch === 'am' ? '+374' : '+7');
}

/**
 * Сколько цифр ожидается после префикса.
 *
 * @param {'ru'|'am'} branch Регион.
 * @returns {number} Количество цифр.
 */
function phoneDigits(branch) {
  const config = CONFIG.branches[branch];
  return (config && config.phoneDigits) || (branch === 'am' ? 8 : 10);
}

/**
 * Оставляет в строке только цифры.
 *
 * @param {string} value Исходная строка.
 * @returns {string} Только цифры.
 */
function digitsOnly(value) {
  return String(value || '').replace(/[^\d]/g, '');
}

/**
 * Форматирует телефон по маске региона в процессе ввода.
 *
 * @param {string} value Сырое значение поля.
 * @param {'ru'|'am'} branch Регион.
 * @returns {string} Отформатированное значение.
 */
export function formatPhone(value, branch) {
  const digits = digitsOnly(value);

  if (branch === 'am') {
    // Армения: +374 XX XXX XXX
    const local = digits.startsWith('374') ? digits.slice(3) : digits;
    const groups = [local.slice(0, 2), local.slice(2, 5), local.slice(5, 8)].filter(Boolean);
    return `+374${groups.length ? ' ' + groups.join(' ') : ''}`;
  }

  // Россия: +7 (XXX) XXX-XX-XX
  let local = digits;
  // Привычная замена 8 → +7: пользователь часто набирает 8XXX.
  if (local.startsWith('8')) {
    local = '7' + local.slice(1);
  }
  if (local.startsWith('7')) {
    local = local.slice(1);
  }
  const parts = [
    local.slice(0, 3),
    local.slice(3, 6),
    local.slice(6, 8),
    local.slice(8, 10),
  ].filter(Boolean);

  if (!parts.length) {
    return '+7 ';
  }
  let out = `+7 (${parts[0]}`;
  if (parts[0].length === 3) {
    out += ')';
  }
  if (parts[1]) {
    out += ` ${parts[1]}`;
  }
  if (parts[2]) {
    out += `-${parts[2]}`;
  }
  if (parts[3]) {
    out += `-${parts[3]}`;
  }
  return out;
}

/**
 * Проверяет полноту номера для региона.
 *
 * @param {string} value Значение поля.
 * @param {'ru'|'am'} branch Регион.
 * @returns {boolean} true, если номер полный.
 */
export function isValidPhone(value, branch) {
  const digits = digitsOnly(value);
  const expected = phoneDigits(branch);
  const local = branch === 'am'
    ? (digits.startsWith('374') ? digits.slice(3) : digits)
    : (digits.startsWith('7') ? digits.slice(1) : digits);
  return local.length === expected;
}

/**
 * Показывает сообщение об ошибке у конкретного поля.
 *
 * Разметка у каждого поля своя ([data-error="phone"] рядом с input), причём
 * для чекбокса согласия сообщение лежит в соседнем узле, а не внутри .field.
 * Поэтому узел ошибки ищем в трёх местах по убыванию точности: по имени поля
 * в атрибуте data-error, внутри обёртки .field и в ближайшем общем предке.
 *
 * @param {HTMLElement|null} field Поле ввода.
 * @param {string} messageKey Ключ сообщения.
 * @param {HTMLFormElement} [form] Форма — нужна для поиска по data-error.
 * @returns {void}
 */
function setFieldError(field, messageKey, form) {
  if (!field) {
    return;
  }

  const wrapper = field.closest('.field') || field.closest('.field--consent') || field.parentElement;
  if (wrapper) {
    wrapper.classList.add('has-error');
  }

  const name = field.getAttribute('name') || '';
  const errorNode =
    (form && name ? form.querySelector(`[data-error="${name}"]`) : null) ||
    (wrapper ? wrapper.querySelector('[data-error], [data-field-error]') : null);

  if (errorNode) {
    setText(errorNode, t(messageKey));
    errorNode.hidden = false;
  } else {
    // Раньше здесь был молчаливый выход — ошибка валидации исчезала, и форма
    // «не отправлялась» без объяснений. Теперь это заметно в консоли.
    console.warn(`[crystal] form: нет узла для сообщения об ошибке поля «${name}»`);
  }

  field.setAttribute('aria-invalid', 'true');
}

/**
 * Снимает все отметки об ошибках.
 *
 * @param {HTMLFormElement} form Форма.
 * @returns {void}
 */
function clearErrors(form) {
  form.querySelectorAll('.field.has-error, .field--consent.has-error').forEach((wrapper) => {
    wrapper.classList.remove('has-error');
  });
  form.querySelectorAll('[data-error], [data-field-error]').forEach((errorNode) => {
    errorNode.hidden = true;
    setText(errorNode, '');
  });
  form.querySelectorAll('[aria-invalid]').forEach((field) => {
    field.removeAttribute('aria-invalid');
  });
}

/**
 * Текущий выбранный регион.
 *
 * В разметке филиал — это группа кнопок .segmented с data-branch-btn,
 * а не radio-инпуты: кнопки проще стилизовать и они доступны с клавиатуры
 * без дополнительной обвязки. Роль radiogroup проставлена в HTML.
 *
 * @param {HTMLFormElement} form Форма.
 * @returns {'ru'|'am'} Регион.
 */
function currentBranch(form) {
  const active = form.querySelector(`[data-branch-btn].${BRANCH_ACTIVE_CLASS}`);
  const value = active ? active.getAttribute('data-branch-btn') : null;
  // Запасной вариант берём из CONFIG.primaryBranch, а не из жёсткого 'ru':
  // основной филиал сайта — Ереван, и если активной кнопки почему-то нет,
  // заявка всё равно должна уйти в правильный чат.
  return normalizeBranch(value);
}

/**
 * Переключает активный филиал и синхронизирует ARIA.
 *
 * @param {HTMLFormElement} form Форма.
 * @param {'ru'|'am'} branch Новый регион.
 * @returns {void}
 */
function selectBranch(form, branch) {
  form.querySelectorAll('[data-branch-btn]').forEach((button) => {
    const isActive = button.getAttribute('data-branch-btn') === branch;
    button.classList.toggle(BRANCH_ACTIVE_CLASS, isActive);
    button.setAttribute('aria-checked', isActive ? 'true' : 'false');
  });
}

/**
 * Показывает общий статус формы.
 *
 * CSS знает три модификатора: --ok, --error, --warn. Список здесь —
 * единственное место, где сопоставляются смысл и оформление.
 *
 * @param {'success'|'error'|'warning'|'loading'|''} kind Тип статуса.
 * @param {string} messageKey Ключ сообщения.
 * @param {object} [params] Параметры интерполяции.
 * @returns {void}
 */
function setStatus(kind, messageKey, params = {}) {
  const node = $('[data-form-status]');
  if (!node) {
    return;
  }

  const modifierByKind = {
    success: 'form-status--ok',
    error: 'form-status--error',
    warning: 'form-status--warn',
    loading: 'form-status--warn',
  };

  node.className = 'form-status';
  if (!kind) {
    node.hidden = true;
    setText(node, '');
    return;
  }

  const modifier = modifierByKind[kind];
  if (modifier) {
    node.classList.add(modifier);
  }
  node.hidden = false;
  node.dataset.status = kind;
  // Текст пишем одной строкой в узел статуса: роль status уже объявлена
  // в разметке, поэтому скринридер прочитает сообщение без наших усилий.
  setText(node, t(messageKey, params));
}

/**
 * Проверяет, настроена ли отправка в выбранный регион.
 *
 * @param {'ru'|'am'} branch Регион.
 * @returns {{ready: boolean, missing: string[]}} Готовность и список пропусков.
 */
export function checkBranchReadiness(branch) {
  const missing = [];

  if (isPlaceholder(CONFIG.telegram.botToken)) {
    missing.push('CONFIG.telegram.botToken');
  }

  const chat = CONFIG.telegram.chats[branch];
  if (!chat || isPlaceholder(chat.chatId)) {
    missing.push(`CONFIG.telegram.chats.${branch}.chatId`);
  }

  if (CONFIG.telegram.transport === 'proxy' && isPlaceholder(CONFIG.telegram.proxyUrl)) {
    missing.push('CONFIG.telegram.proxyUrl');
  }

  return { ready: missing.length === 0, missing };
}

/**
 * Обновляет подсказки формы при смене региона: маску телефона,
 * текст подтверждения и предупреждение о ненастроенном чате.
 *
 * @param {HTMLFormElement} form Форма.
 * @returns {void}
 */
function syncBranchUi(form) {
  const branch = currentBranch(form);

  const phone = form.querySelector('[name="phone"]');
  if (phone) {
    const placeholderKey = branch === 'am' ? 'form.phonePlaceholderAm' : 'form.phonePlaceholderRu';
    phone.setAttribute('placeholder', t(placeholderKey));
    const digits = digitsOnly(phone.value);
    // Если поле пустое или содержит только префикс другого региона — подставляем новый.
    if (!digits || digits === '7' || digits === '374') {
      phone.value = phonePrefix(branch) + ' ';
    }
  }

  const hint = $('[data-branch-hint]');
  if (hint) {
    setText(hint, branch === 'am' ? t('form.branchHintAm') : t('form.branchHintRu'));
  }

  // Карточка контакта выбранного филиала подсвечивается — посетитель видит
  // связь между «куда отправляю» и «кто мне позвонит».
  document.querySelectorAll('[data-contact-branch]').forEach((card) => {
    card.classList.toggle('is-active', card.getAttribute('data-contact-branch') === branch);
  });

  // Честно предупреждаем, если чат ещё не настроен, — вместо молчаливого провала.
  // Текст берём из form.notConfigured: это тот же смысл, что и при попытке
  // отправки — «сайт ещё не подключён», а не ошибка посетителя.
  if (CONFIG.telegram.showConfigWarningToUser && !form.classList.contains('is-busy')) {
    const readiness = checkBranchReadiness(branch);
    const errorNode = $('[data-branch-error]');
    if (errorNode) {
      if (readiness.ready) {
        errorNode.hidden = true;
        setText(errorNode, '');
      } else {
        setText(errorNode, t('form.notConfigured', { vars: readiness.missing.join(', ') }));
        errorNode.hidden = false;
      }
    }
  }

  const status = $('[data-form-status]');
  if (status && status.dataset.status === 'warning') {
    setStatus('', '');
  }
}

/**
 * Собирает payload заявки из полей формы.
 *
 * @param {HTMLFormElement} form Форма.
 * @returns {object} Данные заявки.
 */
function collectPayload(form) {
  const branch = currentBranch(form);
  const calc = getCalcState();

  const name = (form.querySelector('[name="name"]') || {}).value || '';
  const phone = (form.querySelector('[name="phone"]') || {}).value || '';
  const model = (form.querySelector('[name="model"]') || {}).value || '';
  const comment = (form.querySelector('[name="comment"]') || {}).value || '';
  const consentField = form.querySelector(`[name="${CONSENT_FIELD}"]`);

  const payload = {
    branch,
    name: name.trim(),
    phone: phone.trim(),
    model: model.trim(),
    comment: comment.trim(),
    consent: Boolean(consentField && consentField.checked),
    lang: getLanguage(),
    pageUrl: window.location.href,
    iso8601: new Date().toISOString(),
  };

  // Прикладываем расчёт, если пользователь им пользовался.
  if (calc && (calc.vin || calc.carClass)) {
    const quote = calc.quote || null;
    payload.calc = {
      vin: calc.vin || '',
      carClass: calc.carClass || '',
      make: calc.info ? calc.info.make : '',
      model: calc.info ? calc.info.model : '',
      year: calc.info ? calc.info.year : '',
      serviceId: calc.serviceId || '',
      priceLow: quote ? quote.low : 0,
      priceHigh: quote ? quote.high : 0,
    };
  }

  return payload;
}

/**
 * Валидирует форму и расставляет ошибки у полей.
 *
 * @param {HTMLFormElement} form Форма.
 * @returns {boolean} true, если форма валидна.
 */
function validate(form) {
  clearErrors(form);
  const branch = currentBranch(form);
  let valid = true;

  const name = form.querySelector('[name="name"]');
  if (name && String(name.value || '').trim().length < 2) {
    setFieldError(name, 'form.err.name');
    valid = false;
  }

  const phone = form.querySelector('[name="phone"]');
  if (phone) {
    if (!String(phone.value || '').trim()) {
      setFieldError(phone, 'form.err.phone.empty');
      valid = false;
    } else if (!isValidPhone(phone.value, branch)) {
      setFieldError(phone, 'form.err.phone');
      valid = false;
    }
  }

  const model = form.querySelector('[name="model"]');
  if (model && String(model.value || '').trim().length < 2) {
    setFieldError(model, 'form.err.model');
    valid = false;
  }

  const consent = form.querySelector(`[name="${CONSENT_FIELD}"]`);
  if (consent && !consent.checked) {
    setFieldError(consent, 'form.err.consent', form);
    valid = false;
  }

  // Honeypot: в разметке поле называется company, а не website.
  // Проверяем оба имени, чтобы переименование не отключило защиту молча.
  const honeypot = form.querySelector('[data-honeypot]') ||
    form.querySelector('[name="website"]') ||
    form.querySelector('[name="company"]');
  if (honeypot && String(honeypot.value || '').trim()) {
    valid = false;
  }

  return valid;
}

/**
 * Блокирует форму на время отправки.
 *
 * Honeypot и поле согласия не отключаем: отключённый honeypot ломает защиту,
 * а отключённый чекбокс согласия выпал бы из отправляемых данных.
 *
 * @param {HTMLFormElement} form Форма.
 * @param {boolean} busy Состояние занятости.
 * @returns {void}
 */
function setBusy(form, busy) {
  form.classList.toggle('is-busy', busy);

  const button = $('[data-form-submit]', form) || form.querySelector('[type="submit"]');
  const spinner = $('[data-form-spinner]', form);
  if (button) {
    button.disabled = busy;
  }
  if (spinner) {
    spinner.hidden = !busy;
  }
}

/**
 * Обрабатывает отправку формы.
 *
 * @param {HTMLFormElement} form Форма.
 * @returns {Promise<void>}
 */
async function handleSubmit(form) {
  if (!validate(form)) {
    setStatus('error', 'form.err.fix');
    return;
  }

  const payload = collectPayload(form);
  setBusy(form, true);
  setStatus('loading', 'form.sending');

  try {
    const result = await sendLead(payload);

    if (result.ok) {
      setStatus('success', 'form.success');
      form.reset();

      // После reset() переключатель возвращается к визуальному состоянию
      // «Россия» из разметки, а поле телефона нужно переформатировать.
      selectBranch(form, 'ru');
      const phone = form.querySelector('[name="phone"]');
      if (phone) {
        phone.value = '';
      }

      // Резервный канал — только если он настроен (R-39).
      sendFallback(payload).catch(() => {});

      onBus(EVENTS.FORM_SENT, { branch: payload.branch });
      return;
    }

    if (result.status === 'not_configured') {
      // Это НЕ ошибка пользователя: сайт просто ещё не подключён к Telegram.
      const readiness = checkBranchReadiness(payload.branch);
      setStatus('warning', 'form.notConfigured', { vars: readiness.missing.join(', ') });
      return;
    }

    setStatus('error', 'form.errorSend');
  } catch (error) {
    console.error('[crystal] form: непредвиденный сбой отправки', error);
    setStatus('error', 'form.errorSend');
  } finally {
    setBusy(form, false);
    syncBranchUi(form);
  }
}

/**
 * Инициализирует форму.
 *
 * @returns {void}
 */
export function init() {
  const form = $('[data-form]');
  if (!form) {
    return;
  }

  // Селект услуг в форме строится из того же CONFIG, что и в калькуляторе:
  // два независимых списка разошлись бы при первой же правке прайса.
  const serviceSelect = $('[data-form-service]', form);
  if (serviceSelect) {
    serviceSelect.textContent = '';
    [...(CONFIG.pricing.services || [])]
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .forEach((service) => {
        const option = document.createElement('option');
        option.value = service.id;
        option.textContent = t(`services.${service.id}.name`);
        serviceSelect.appendChild(option);
      });
  }

  // Переключение региона кнопками-сегментами.
  form.querySelectorAll('[data-branch-btn]').forEach((button) => {
    on(button, 'click', () => {
      const branch = button.getAttribute('data-branch-btn');
      if (branch !== 'ru' && branch !== 'am') {
        return;
      }
      selectBranch(form, branch);
      syncBranchUi(form);
    });
  });

  // Кнопка «очистить».
  const resetButton = $('[data-form-reset]', form);
  if (resetButton) {
    on(resetButton, 'click', () => {
      form.reset();
      selectBranch(form, 'ru');
      clearErrors(form);
      setStatus('', '');
      syncBranchUi(form);
    });
  }

  // Маска телефона: форматируем на вводе, но не мешаем стирать.
  const phone = form.querySelector('[name="phone"]');
  if (phone) {
    on(phone, 'input', () => {
      const branch = currentBranch(form);
      const formatted = formatPhone(phone.value, branch);
      if (formatted !== phone.value) {
        phone.value = formatted;
      }
      // Снимаем ошибку, как только пользователь начал исправлять.
      const wrapper = phone.closest('.field');
      if (wrapper && wrapper.classList.contains('has-error')) {
        wrapper.classList.remove('has-error');
        const errorNode = form.querySelector('[data-error="phone"]');
        if (errorNode) {
          errorNode.hidden = true;
          setText(errorNode, '');
        }
      }
    });

    on(phone, 'focus', () => {
      if (!digitsOnly(phone.value)) {
        phone.value = phonePrefix(currentBranch(form)) + ' ';
      }
    });

    // Backspace на «+7 » не должен оставлять пользователя без префикса.
    on(phone, 'blur', () => {
      if (!digitsOnly(phone.value)) {
        phone.value = '';
      }
    });
  }

  on(form, 'submit', (event) => {
    event.preventDefault();
    handleSubmit(form);
  });

  // Заполнение из калькулятора.
  onBus(EVENTS.FORM_PREFILL, (detail) => {
    if (!detail) {
      return;
    }
    const model = form.querySelector('[name="model"]');
    if (model && detail.model && !model.value) {
      model.value = detail.model;
    }
    if (detail.serviceId && serviceSelect) {
      serviceSelect.value = detail.serviceId;
    }
    clearErrors(form);
    setStatus('', '');
  });

  // При смене языка пересобираем селект услуг и подсказки филиала: они
  // построены из JS, движок i18n их не видит.
  onBus(EVENTS.I18N_CHANGED, () => {
    const selected = serviceSelect ? serviceSelect.value : null;
    if (serviceSelect) {
      serviceSelect.textContent = '';
      [...(CONFIG.pricing.services || [])]
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .forEach((service) => {
          const option = document.createElement('option');
          option.value = service.id;
          option.textContent = t(`services.${service.id}.name`);
          serviceSelect.appendChild(option);
        });
      if (selected) {
        serviceSelect.value = selected;
      }
    }
    clearErrors(form);
    syncBranchUi(form);
  });

  syncBranchUi(form);
}

export default { init, formatPhone, isValidPhone, checkBranchReadiness };
