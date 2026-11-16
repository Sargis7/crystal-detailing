/**
 * VIN-калькулятор: ввод → валидация → расшифровка → класс авто → цена.
 *
 * ВАЖНЫЙ КОНТРАКТ: модуль общается с VIN-логикой ТОЛЬКО через provider.
 * Ни decoder.js, ни pricing.js здесь не импортируются напрямую — иначе
 * переключение `CONFIG.vin.provider` с 'local' на 'api' потребовало бы
 * правки этого файла (требование R-26).
 *
 * РЕЖИМ ЦЕН: при `CONFIG.pricing.priceMode === 'on-request'` числа не
 * показываются — вместо суммы выводится «Цена по запросу» и предложение
 * оставить заявку. Это текущий режим, выбранный заказчиком.
 *
 * @module js/calculator
 */

import { $, on, setText, toggleClass, scrollToElement } from './core/dom.js';
import { emit, on as onBus, EVENTS } from './core/events.js';
import { t } from './core/i18n.js';
import { CONFIG, isPlaceholder } from './config.js';
import { getProvider } from './vin/provider.js';
import { resolveClass, quote as quoteFor } from './vin/pricing.js';

/** @type {{vin: string, info: object|null, carClass: number|null, serviceId: string|null}} */
const state = {
  vin: '',
  info: null,
  carClass: null,
  serviceId: null,
};

/**
 * Показывает ли сайт конкретные суммы (в противовес «по запросу»).
 *
 * @returns {boolean} true, если числа можно показывать.
 */
function showsNumbers() {
  return (CONFIG.pricing && CONFIG.pricing.priceMode) === 'fixed';
}

/**
 * Класс автомобиля по умолчанию, если распознать не удалось.
 *
 * @returns {number} Класс 1–5.
 */
function defaultClass() {
  return (CONFIG.pricing && CONFIG.pricing.defaultClass) || 2;
}

/**
 * Отрисовывает состояние ошибки.
 *
 * @param {string} messageKey Ключ сообщения об ошибке.
 * @returns {void}
 */
function showError(messageKey) {
  const box = $('[data-calc-error]');
  const title = $('[data-calc-error-title]');
  const text = $('[data-calc-error-text]');
  const resultNode = $('[data-calc-result]');

  // Разметка предусматривает и заголовок, и пояснение: в заголовок идёт
  // общая фраза, в пояснение — конкретная причина. Так ошибка «VIN из 16
  // символов» не подменяет собой заголовок целиком.
  if (title) {
    setText(title, t('calc.err.generic'));
  }
  if (text) {
    setText(text, t(messageKey));
  }
  if (box) {
    box.hidden = false;
  }
  if (resultNode) {
    resultNode.hidden = true;
  }
}

/**
 * Убирает сообщение об ошибке.
 *
 * @returns {void}
 */
function clearError() {
  const box = $('[data-calc-error]');
  const text = $('[data-calc-error-text]');
  if (text) {
    setText(text, '');
  }
  if (box) {
    box.hidden = true;
  }
}

/**
 * Применяет выбранную услугу к расчёту и обновляет подписи.
 * Цены берутся из provider, поэтому при смене провайдера ничего не меняется.
 *
 * @returns {Promise<void>}
 */
async function refreshQuote() {
  const resultNode = $('[data-calc-result]');
  const priceNode = $('[data-calc-price]');
  const disclaimerNode = $('[data-calc-disclaimer]');
  const classNode = $('[data-calc-class]');
  const carNode = $('[data-calc-car]');
  const makeNode = $('[data-calc-make]');
  const modelNode = $('[data-calc-model]');
  const yearNode = $('[data-calc-year]');
  const sourceNode = $('[data-calc-source]');
  const guessNode = $('[data-calc-guess]');
  const manualApply = $('[data-calc-manual-apply]');

  if (!resultNode) {
    return;
  }

  if (!state.info) {
    resultNode.hidden = true;
    return;
  }

  const info = state.info;
  const carClass = state.carClass || defaultClass();
  const unknown = t('calc.resultUnknown');

  // ── Спецификация автомобиля ────────────────────────────────────────────
  // Показываем прочерк-заглушку переведённым текстом, а не «—»: иначе
  // армянский посетитель видит символ без объяснения.
  if (makeNode) {
    setText(makeNode, info.make || unknown);
  }
  if (modelNode) {
    setText(modelNode, info.model || unknown);
  }
  if (yearNode) {
    setText(yearNode, info.year ? String(info.year) : unknown);
  }
  if (classNode) {
    setText(classNode, t('calc.resultClassValue', { n: carClass }));
  }

  // Короткая подпись «Mazda CX-5 2019» — то, что человек узнаёт с одного
  // взгляда; если распознать не удалось, честно пишем об этом.
  const parts = [info.make, info.model, info.year].filter(Boolean).join(' ');
  if (carNode) {
    setText(carNode, parts || t('calc.classSelected', { n: carClass }));
  }

  // Источник данных: посетитель имеет право знать, откуда взялась марка.
  if (sourceNode) {
    if (info.source === 'manual') {
      sourceNode.hidden = true;
    } else {
      setText(sourceNode, info.source === 'api' ? t('calc.sourceApi') : t('calc.sourceLocal'));
      sourceNode.hidden = false;
    }
  }

  // «Класс определён приблизительно» — только когда это правда.
  if (guessNode) {
    guessNode.hidden = !info.classGuessed;
  }

  // Класс выбирается вручную ровно тогда, когда автоматика не справилась.
  // Держим select в согласии с состоянием: иначе после пересчёта в нём
  // остался бы прежний выбор.
  const classSelect = $('[data-calc-class-select]');
  if (classSelect) {
    classSelect.value = String(carClass);
  }
  if (manualApply) {
    manualApply.disabled = false;
  }

  const serviceId = state.serviceId || (CONFIG.pricing.services[0] && CONFIG.pricing.services[0].id);

  // ── Цена ───────────────────────────────────────────────────────────────
  if (!showsNumbers()) {
    // РЕЖИМ «ПО ЗАПРОСУ»: числа не показываем ни при каких условиях.
    // Это не заглушка, а осознанное решение заказчика: прайс не публикуется,
    // а расчёт по VIN работает как квалификация заявки.
    if (priceNode) {
      setText(priceNode, t('services.onRequest'));
    }
    if (disclaimerNode) {
      setText(disclaimerNode, t('services.onRequestHint'));
    }
    resultNode.hidden = false;
    emit(EVENTS.CALC_RESULT, {
      vehicleInfo: info,
      carClass,
      serviceId,
      priceMode: 'on-request',
    });
    return;
  }

  const quote = quoteFor(serviceId, carClass);

  if (!quote) {
    resultNode.hidden = true;
    return;
  }

  if (priceNode) {
    setText(priceNode, `${quote.total.toLocaleString('ru-RU')} ₽`);
  }
  if (disclaimerNode) {
    const range = quote.fromFixed
      ? t('calc.priceFixed', { price: quote.total.toLocaleString('ru-RU'), currency: '₽' })
      : t('calc.priceRange', {
        low: quote.low.toLocaleString('ru-RU'),
        high: quote.high.toLocaleString('ru-RU'),
        currency: '₽',
      });
    setText(disclaimerNode, `${range}. ${t('calc.disclaimer')}`);
  }
  resultNode.hidden = false;

  emit(EVENTS.CALC_RESULT, {
    vehicleInfo: info,
    carClass,
    serviceId,
    quote,
    priceMode: 'fixed',
  });
}

/**
 * Обрабатывает нажатие «Рассчитать».
 *
 * @returns {Promise<void>}
 */
async function handleSubmit() {
  const input = $('[data-vin-input]');
  const button = $('[data-calc-submit]');
  if (!input) {
    return;
  }

  clearError();

  const raw = String(input.value || '').trim();
  if (!raw) {
    showError('calc.err.required');
    return;
  }

  if (button) {
    button.disabled = true;
    button.classList.add('is-loading');
  }

  // Индикатор «Определяем автомобиль…» показываем только на время работы
  // провайдера: при офлайн-расшифровке он мелькнёт и исчезнет, при внешнем
  // API — провисит заметное время. Оба варианта корректны.
  const loading = $('[data-calc-loading]');
  if (loading) {
    loading.hidden = false;
  }

  try {
    const provider = getProvider();
    const info = await provider.decode(raw);

    // Ошибки валидации приходят кодами — превращаем их в текст на нужном языке.
    if (info.errorCode && info.errorCode !== 'unknownApproved') {
      const keyByCode = {
        required: 'calc.err.required',
        length: 'calc.err.length',
        chars: 'calc.err.chars',
        checksum: 'calc.err.checksum',
      };
      showError(keyByCode[info.errorCode] || 'calc.err.generic');
      state.info = null;
      state.carClass = null;
      return;
    }

    state.vin = info.vin || raw;
    state.info = info;

    const resolved = resolveClass(info);
    state.carClass = resolved.carClass;

    // Если марка/модель не распознаны, честно предлагаем выбрать класс вручную
    // (R-27) — это равноценный путь, а не «аварийный».
    const manualWrap = $('[data-calc-manual]');
    if (manualWrap) {
      manualWrap.hidden = Boolean(info.make || info.model);
    }

    await refreshQuote();
  } catch (error) {
    console.error('[crystal] calculator: сбой расчёта', error);
    showError('calc.err.generic');
  } finally {
    if (loading) {
      loading.hidden = true;
    }
    if (button) {
      button.disabled = false;
      button.classList.remove('is-loading');
    }
  }
}

/**
 * Сбрасывает калькулятор.
 *
 * @returns {void}
 */
export function reset() {
  const input = $('[data-vin-input]');
  if (input) {
    input.value = '';
  }
  const resultNode = $('[data-calc-result]');
  if (resultNode) {
    resultNode.hidden = true;
  }
  const manualWrap = $('[data-calc-manual]');
  if (manualWrap) {
    manualWrap.hidden = true;
  }
  const loading = $('[data-calc-loading]');
  if (loading) {
    loading.hidden = true;
  }
  state.vin = '';
  state.info = null;
  state.carClass = null;
  state.serviceId = null;
  clearError();
  emit(EVENTS.CALC_RESET, null);
}

/**
 * Возвращает локализованное название услуги по её id из CONFIG.pricing.services.
 *
 * @param {string} serviceId Идентификатор услуги.
 * @returns {string} Название на текущем языке.
 */
function serviceLabel(serviceId) {
  return t(`services.${serviceId}.name`);
}

/**
 * Заполняет селект услуг и селект классов.
 *
 * Оба списка строятся из CONFIG, а не хардкодятся в HTML: добавить услугу
 * можно правкой config.js и словарей, не трогая разметку (требование R-30).
 *
 * @returns {void}
 */
function fillSelects() {
  const serviceSelect = $('[data-calc-service]');
  if (serviceSelect) {
    const services = [...(CONFIG.pricing.services || [])].sort(
      (a, b) => (a.order || 0) - (b.order || 0)
    );
    serviceSelect.textContent = '';
    services.forEach((service, index) => {
      const option = document.createElement('option');
      option.value = service.id;
      option.textContent = serviceLabel(service.id);
      if (index === 0) {
        option.selected = true;
      }
      serviceSelect.appendChild(option);
    });
    state.serviceId = services.length ? services[0].id : null;
  }

  const classSelect = $('[data-calc-class-select]');
  if (classSelect) {
    classSelect.textContent = '';
    Object.keys(CONFIG.pricing.classMultipliers || {})
      .map(Number)
      .sort((a, b) => a - b)
      .forEach((cls) => {
        const option = document.createElement('option');
        option.value = String(cls);
        // Ключ calc.class1…calc.class5 уже содержит и номер, и описание
        // класса — второй раз номер не подставляем.
        option.textContent = t(`calc.class${cls}`);
        if (cls === defaultClass()) {
          option.selected = true;
        }
        classSelect.appendChild(option);
      });
  }
}

/**
 * Отдаёт текущее состояние — нужно форме, чтобы приложить расчёт к заявке.
 *
 * @returns {{vin: string, info: object|null, carClass: number|null, serviceId: string|null}} Снимок состояния.
 */
export function getState() {
  return { ...state };
}

/**
 * Инициализирует калькулятор.
 *
 * @returns {void}
 */
export function init() {
  // Форма калькулятора в разметке помечена data-calc, а не data-calc-form:
  // селектор ниже — единственное место, где об этом нужно помнить.
  const form = $('[data-calc]');
  const input = $('[data-vin-input]');

  fillSelects();

  if (form) {
    on(form, 'submit', (event) => {
      event.preventDefault();
      handleSubmit();
    });
  }

  if (input) {
    // VIN вводится латиницей; приводим к верхнему регистру сразу, чтобы
    // пользователь видел нормализованное значение и не удивлялся ошибке.
    on(input, 'input', () => {
      const normalized = String(input.value || '').toUpperCase().replace(/\s+/g, '');
      if (normalized !== input.value) {
        input.value = normalized;
      }
      if (input.value.length === 17) {
        // Довели до длины — можно считать сами, не заставляя жать кнопку.
        handleSubmit();
      }
    });
  }

  // Тултип «что такое VIN»: раскрывается по кнопке «?».
  const helpButton = $('[data-vin-help]');
  const tooltip = $('[data-vin-tooltip]');
  if (helpButton && tooltip) {
    on(helpButton, 'click', () => {
      const expanded = helpButton.getAttribute('aria-expanded') === 'true';
      helpButton.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      tooltip.hidden = expanded;
    });
  }

  // Ручной выбор класса — равноценный путь (R-27).
  const manualSelect = $('[data-calc-class-select]');
  if (manualSelect) {
    on(manualSelect, 'change', () => {
      const value = Number(manualSelect.value);
      if (Number.isInteger(value) && value >= 1 && value <= 5) {
        state.carClass = value;
        // Если VIN ещё не вводили, ручной выбор класса — полноценная замена
        // расшифровке: расчёт по нему так же точен, просто без марки и года.
        if (!state.info) {
          state.info = { source: 'manual', carClass: value, classGuessed: false };
          const manualWrap = $('[data-calc-manual]');
          if (manualWrap) {
            manualWrap.hidden = false;
          }
        } else {
          state.info = { ...state.info, classGuessed: false };
        }
        refreshQuote();
      }
    });

    // Кнопка «применить» подтверждает выбор; change уже всё сделал, поэтому
    // здесь только прокрутка к результату — иначе кнопка выглядит мёртвой.
    const manualApply = $('[data-calc-manual-apply]');
    if (manualApply) {
      on(manualApply, 'click', () => {
        const resultNode = $('[data-calc-result]');
        if (state.info && resultNode) {
          refreshQuote();
          scrollToElement(resultNode);
        } else {
          showError('calc.err.generic');
        }
      });
    }
  }

  // Выбор услуги внутри калькулятора.
  const serviceSelect = $('[data-calc-service]');
  if (serviceSelect) {
    on(serviceSelect, 'change', () => {
      state.serviceId = serviceSelect.value || null;
      refreshQuote();
    });
  }

  // Кнопка «сбросить».
  const resetButton = $('[data-calc-reset]');
  if (resetButton) {
    on(resetButton, 'click', reset);
  }

  // Ссылка «записаться на эту услугу» ведёт в форму и передаёт ей расчёт.
  // Клик не отменяем: якорь должен отработать сам, а данные уедут событием.
  const cta = $('[data-calc-prefill]');
  if (cta) {
    on(cta, 'click', () => {
      const info = state.info;
      const carText = info
        ? [info.make, info.model, info.year].filter(Boolean).join(' ')
        : '';
      emit(EVENTS.FORM_PREFILL, {
        model: carText,
        vin: state.vin,
        carClass: state.carClass,
        serviceId: state.serviceId,
      });
    });
  }

  // При смене языка перерисовываем динамику: в селектах и результате есть
  // слова, которые движок i18n перевести не может — они созданы из JS.
  onBus(EVENTS.I18N_CHANGED, () => {
    const selectedService = state.serviceId;
    const selectedClass = state.carClass;
    fillSelects();
    // fillSelects сбрасывает выбор на первый элемент — возвращаем прежний.
    if (selectedService && serviceSelect) {
      serviceSelect.value = selectedService;
      state.serviceId = selectedService;
    }
    if (selectedClass && manualSelect) {
      manualSelect.value = String(selectedClass);
      state.carClass = selectedClass;
    }
    if (state.info) {
      refreshQuote();
    } else {
      clearError();
    }
  });
}

export default { init, reset, getState };
