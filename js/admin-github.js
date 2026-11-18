/**
 * ПУБЛИКАЦИЯ ПРАВОК В GITHUB ИЗ АДМИН-ПАНЕЛИ.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ЧТО ПРОИСХОДИТ ПРИ ЛЮБОМ ИЗМЕНЕНИИ
 * ──────────────────────────────────────────────────────────────────────────
 * Админка собирает полное актуальное состояние (buildRemotePayload) и
 * кладёт его в один файл репозитория — data/site-overrides.json. Дальше
 * GitHub Contents API делает коммит в ветку, из которой собран GitHub Pages.
 * Страница посетителя забирает этот файл при загрузке (js/core/remote.js),
 * поэтому правка «доезжает» всем через 30–60 секунд — время пересборки Pages.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ПОЧЕМУ CONTENT API, А НЕ git data API
 * ──────────────────────────────────────────────────────────────────────────
 * Contents API умеет создать коммит одним PUT-запросом: отдать base64 тела
 * и sha предыдущей версии. git data API (blobs → trees → commits → refs)
 * даёт атомарность для нескольких файлов, но требует 4–5 запросов и ручной
 * работы с деревьями. Здесь файл один, конфликтов между файлами не бывает,
 * поэтому простой путь надёжнее: меньше запросов — меньше поводов упасть.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * ТОКЕН
 * ──────────────────────────────────────────────────────────────────────────
 * Токен хранится в localStorage этого браузера и НЕ попадает в репозиторий.
 * Нужен fine-grained token с доступом Contents: Read and write на один
 * репозиторий — этого достаточно, и при утечке ущерб ограничен сайтом.
 *
 * ⚠️ ЧЕСТНОЕ ОГРАНИЧЕНИЕ. Кто получил доступ к браузеру заказчика или к
 * его localStorage — получил и токен. Поэтому: отдельный токен только под
 * этот репозиторий, срок действия, отзыв при смене устройства. Это
 * записано и в README, и в подсказке самой панели.
 *
 * @module js/admin-github
 */

import { REMOTE_FILE } from './core/content.js';

/** Ключ localStorage для настроек публикации. */
const SETTINGS_KEY = 'github_publish';

/**
 * @typedef {Object} PublishSettings
 * @property {string} owner Владелец репозитория.
 * @property {string} repo Имя репозитория.
 * @property {string} branch Ветка, из которой собран Pages.
 * @property {string} token Токен с правом Contents: write.
 * @property {string} path Путь к файлу правок.
 * @property {boolean} enabled Публиковать ли автоматически.
 */

/** @type {PublishSettings} Значения по умолчанию — под этот проект. */
export const DEFAULTS = {
  owner: 'Sargis7',
  repo: 'crystal-detailing',
  branch: 'main',
  token: '',
  path: REMOTE_FILE,
  enabled: true,
};

/**
 * Читает настройки из localStorage. Битые данные не должны ломать панель:
 * при ошибке возвращаются значения по умолчанию с пустым токеном.
 *
 * @returns {PublishSettings} Настройки.
 */
export function readSettings() {
  try {
    const raw = window.localStorage.getItem(`crystal_${SETTINGS_KEY}`);
    if (!raw) {
      return { ...DEFAULTS };
    }
    const parsed = JSON.parse(raw);
    return {
      owner: typeof parsed.owner === 'string' && parsed.owner ? parsed.owner : DEFAULTS.owner,
      repo: typeof parsed.repo === 'string' && parsed.repo ? parsed.repo : DEFAULTS.repo,
      branch: typeof parsed.branch === 'string' && parsed.branch ? parsed.branch : DEFAULTS.branch,
      token: typeof parsed.token === 'string' ? parsed.token : '',
      path: typeof parsed.path === 'string' && parsed.path ? parsed.path : DEFAULTS.path,
      enabled: parsed.enabled !== false,
    };
  } catch (error) {
    console.warn('[crystal] github: настройки не прочитались', error);
    return { ...DEFAULTS };
  }
}

/**
 * Сохраняет настройки.
 *
 * @param {PublishSettings} settings Настройки.
 * @returns {boolean} Удалось ли записать.
 */
export function writeSettings(settings) {
  try {
    window.localStorage.setItem(`crystal_${SETTINGS_KEY}`, JSON.stringify(settings));
    return true;
  } catch (error) {
    console.warn('[crystal] github: настройки не сохранились', error);
    return false;
  }
}

/**
 * Готов ли механизм к работе: заполнены владелец, репозиторий и токен.
 *
 * @param {PublishSettings} [settings] Настройки; по умолчанию читаются из хранилища.
 * @returns {boolean} true, если публиковать можно.
 */
export function isConfigured(settings) {
  const s = settings || readSettings();
  return Boolean(s.owner && s.repo && s.token);
}

/**
 * Кодирует строку в base64 с UTF-8. Без TextEncoder и явного прохода по
 * байтам btoa падает на не-ASCII символах, а русские названия услуг и
 * адреса в файле есть всегда.
 *
 * @param {string} text Текст.
 * @returns {string} base64.
 */
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return window.btoa(binary);
}

/**
 * Декодирует base64 с UTF-8.
 *
 * @param {string} base64 Данные.
 * @returns {string} Текст.
 */
function fromBase64(base64) {
  const binary = window.atob(base64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Ошибка публикации с человекочитаемым объяснением. Отдельный класс нужен,
 * чтобы интерфейс мог показать текст напрямую, а не «HTTP 401».
 */
export class PublishError extends Error {
  /**
   * @param {string} message Что показать пользователю.
   * @param {number} [status] Код ответа GitHub, если был.
   */
  constructor(message, status) {
    super(message);
    this.name = 'PublishError';
    this.status = status;
  }
}

/**
 * Расшифровывает код ответа GitHub в действие.
 *
 * @param {number} status HTTP-код.
 * @param {string} body Тело ответа.
 * @returns {string} Объяснение.
 */
function explain(status, body) {
  switch (status) {
    case 401:
      return 'Токен не принят GitHub. Проверьте, что он скопирован целиком и не истёк.';
    case 403:
      return 'Токену не хватает прав. Нужен доступ Contents: Read and write на этот репозиторий.';
    case 404:
      return 'Репозиторий или ветка не найдены. Проверьте владельца, имя репозитория и ветку.';
    case 409:
      return 'Файл изменился с момента последнего чтения. Повторите сохранение — панель перечитает файл.';
    case 422:
      return 'GitHub отклонил данные коммита. Обычно это неверный base64 или пустой файл.';
    default: {
      const clean = String(body || '').replace(/\s+/g, ' ').slice(0, 200);
      return `GitHub ответил ${status}${clean ? `: ${clean}` : ''}`;
    }
  }
}

/**
 * Базовый адрес API для текущих настроек.
 *
 * @param {PublishSettings} settings Настройки.
 * @returns {string} URL.
 */
function apiUrl(settings) {
  const path = settings.path.split('/').map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${encodeURIComponent(settings.owner)}`
    + `/${encodeURIComponent(settings.repo)}/contents/${path}`;
}

/**
 * Заголовки запроса. `Accept` обязателен: без него GitHub отдаёт 415.
 *
 * @param {PublishSettings} settings Настройки.
 * @returns {Record<string, string>} Заголовки.
 */
function headers(settings) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${settings.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

/**
 * Читает текущую версию файла из репозитория.
 *
 * Отсутствие файла — не ошибка: первый коммит создаёт его с нуля, и в этом
 * случае sha просто не передаётся.
 *
 * @param {PublishSettings} settings Настройки.
 * @returns {Promise<{sha: string|null, text: string|null}>} sha и содержимое.
 */
export async function readRemote(settings) {
  const url = `${apiUrl(settings)}?ref=${encodeURIComponent(settings.branch)}`;
  let response;
  try {
    response = await fetch(url, { headers: headers(settings), cache: 'no-store' });
  } catch (error) {
    throw new PublishError('Нет связи с GitHub. Проверьте интернет и попробуйте снова.');
  }
  if (response.status === 404) {
    return { sha: null, text: null };
  }
  if (!response.ok) {
    throw new PublishError(explain(response.status, await response.text()), response.status);
  }
  const data = await response.json();
  return {
    sha: typeof data.sha === 'string' ? data.sha : null,
    text: typeof data.content === 'string' ? fromBase64(data.content) : null,
  };
}

/**
 * Кладёт содержимое в репозиторий одним коммитом.
 *
 * @param {PublishSettings} settings Настройки.
 * @param {string} text Новое содержимое файла.
 * @param {string} message Текст коммита.
 * @returns {Promise<{sha: string, commitUrl: string}>} Итог.
 */
export async function writeRemote(settings, text, message) {
  // sha читаем непосредственно перед записью, а не кэшируем при открытии
  // панели: за время работы заказчика файл мог изменить другой компьютер,
  // и без актуального sha GitHub вернул бы 409.
  let current = { sha: null, text: null };
  try {
    current = await readRemote(settings);
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
  }

  // Не коммитим, если содержимое не изменилось: каждый пустой коммит
  // запускает пересборку Pages, а она небесплатная по времени.
  if (current.text !== null && current.text.trim() === text.trim()) {
    return { sha: current.sha || '', commitUrl: '', unchanged: true };
  }

  const body = {
    message,
    content: toBase64(text),
    branch: settings.branch,
  };
  if (current.sha) {
    body.sha = current.sha;
  }

  let response;
  try {
    response = await fetch(apiUrl(settings), {
      method: 'PUT',
      headers: headers(settings),
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new PublishError('Нет связи с GitHub. Правка сохранена в браузере, но не опубликована.');
  }
  if (!response.ok) {
    throw new PublishError(explain(response.status, await response.text()), response.status);
  }
  const data = await response.json();
  return {
    sha: data.content && data.content.sha ? data.content.sha : '',
    commitUrl: data.commit && data.commit.html_url ? data.commit.html_url : '',
    unchanged: false,
  };
}

/**
 * Проверяет токен и доступ к репозиторию, ничего не записывая.
 * Используется кнопкой «Проверить подключение».
 *
 * @param {PublishSettings} settings Настройки.
 * @returns {Promise<{login: string, canWrite: boolean, defaultBranch: string}>} Итог.
 */
export async function checkAccess(settings) {
  let userResponse;
  try {
    userResponse = await fetch('https://api.github.com/user', {
      headers: headers(settings),
      cache: 'no-store',
    });
  } catch (error) {
    throw new PublishError('Нет связи с GitHub. Проверьте интернет.');
  }
  if (!userResponse.ok) {
    throw new PublishError(explain(userResponse.status, await userResponse.text()), userResponse.status);
  }
  const user = await userResponse.json();

  let repoResponse;
  try {
    repoResponse = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(settings.owner)}/${encodeURIComponent(settings.repo)}`,
      { headers: headers(settings), cache: 'no-store' }
    );
  } catch (error) {
    throw new PublishError('Нет связи с GitHub. Проверьте интернет.');
  }
  if (!repoResponse.ok) {
    throw new PublishError(explain(repoResponse.status, await repoResponse.text()), repoResponse.status);
  }
  const repo = await repoResponse.json();

  // permissions.push есть только у токенов с правом записи; у fine-grained
  // токена флаг приходит в permissions или отсутствует вовсе. Отсутствие
  // считаем «может писать»: настоящую попытку покажет сам коммит, а ложный
  // запрет пугал бы заказчика на ровном месте.
  const perms = repo.permissions || {};
  const canWrite = perms.push !== false;

  return {
    login: user.login || '',
    canWrite,
    defaultBranch: repo.default_branch || DEFAULTS.branch,
  };
}

export default {
  DEFAULTS,
  PublishError,
  readSettings,
  writeSettings,
  isConfigured,
  readRemote,
  writeRemote,
  checkAccess,
};
