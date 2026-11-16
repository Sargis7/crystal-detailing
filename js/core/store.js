/**
 * Безопасная обёртка над localStorage.
 *
 * Зачем обёртка, а не прямой localStorage:
 *  - Safari в приватном режиме бросает QuotaExceededError на ЛЮБУЮ запись;
 *  - при переполнении хранилища setItem тоже бросает исключение;
 *  - некоторые корпоративные политики отключают storage целиком.
 * Ни в одном из этих случаев сайт не должен падать — поэтому используется
 * in-memory fallback, прозрачный для остального кода.
 *
 * @module js/core/store
 */

/**
 * Префикс всех ключей проекта — чтобы не конфликтовать с чужими данными.
 * Экспортируется: слушатели события storage получают «сырой» ключ браузера
 * (с префиксом) и должны сравнивать его, не собирая строку вручную.
 */
export const PREFIX = 'crystal_';

/** @type {Map<string, string>} Резервное хранилище в памяти процесса. */
const memoryFallback = new Map();

/** @type {boolean} Доступен ли настоящий localStorage. */
let storageAvailable = false;

/**
 * Проверяет доступность localStorage реальной записью.
 * Проверка «typeof localStorage !== 'undefined'» недостаточна: в приватном
 * режиме Safari объект существует, но методы бросают исключения.
 *
 * @returns {boolean} true, если можно пользоваться localStorage.
 */
function detectStorage() {
  try {
    const probeKey = `${PREFIX}__probe__`;
    window.localStorage.setItem(probeKey, '1');
    window.localStorage.removeItem(probeKey);
    return true;
  } catch (error) {
    console.warn('[crystal] localStorage недоступен, используется память процесса:', error);
    return false;
  }
}

/**
 * Инициализация хранилища. Вызывается один раз при старте приложения.
 *
 * @returns {void}
 */
export function init() {
  storageAvailable = detectStorage();
}

/**
 * Читает значение по ключу.
 *
 * @param {string} key Ключ без префикса, например 'lang'.
 * @param {*} [fallback=null] Значение, возвращаемое при отсутствии ключа.
 * @returns {*} Разобранное из JSON значение либо fallback.
 */
export function get(key, fallback = null) {
  const fullKey = PREFIX + key;
  try {
    const raw = storageAvailable
      ? window.localStorage.getItem(fullKey)
      : (memoryFallback.has(fullKey) ? memoryFallback.get(fullKey) : null);

    if (raw === null || raw === undefined) {
      return fallback;
    }
    return JSON.parse(raw);
  } catch (error) {
    console.warn(`[crystal] не удалось прочитать ключ "${key}":`, error);
    return fallback;
  }
}

/**
 * Записывает значение по ключу.
 *
 * @param {string} key Ключ без префикса.
 * @param {*} value Любое сериализуемое значение.
 * @returns {boolean} true, если запись прошла успешно.
 */
export function set(key, value) {
  const fullKey = PREFIX + key;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    console.warn(`[crystal] значение ключа "${key}" не сериализуется:`, error);
    return false;
  }

  memoryFallback.set(fullKey, serialized);

  if (!storageAvailable) {
    return false;
  }
  try {
    window.localStorage.setItem(fullKey, serialized);
    return true;
  } catch (error) {
    console.warn(`[crystal] не удалось записать ключ "${key}" в localStorage:`, error);
    storageAvailable = false;
    return false;
  }
}

/**
 * Удаляет ключ.
 *
 * @param {string} key Ключ без префикса.
 * @returns {void}
 */
export function remove(key) {
  const fullKey = PREFIX + key;
  memoryFallback.delete(fullKey);
  if (!storageAvailable) {
    return;
  }
  try {
    window.localStorage.removeItem(fullKey);
  } catch (error) {
    console.warn(`[crystal] не удалось удалить ключ "${key}":`, error);
  }
}

/** @type {string} Ключ согласия на cookie — используется cookie.js и аналитикой. */
export const KEY_COOKIE_CONSENT = 'cookie_consent';

/** @type {string} Ключ выбранного языка. */
export const KEY_LANG = 'lang';

export default { init, get, set, remove, KEY_COOKIE_CONSENT, KEY_LANG };
