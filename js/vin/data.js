/**
 * Таблицы данных VIN-декодера. ТОЛЬКО данные — никакой логики.
 *
 * Таблицы намеренно неполные, но честные: собранные здесь марки покрывают
 * основную часть автопарка России и Армении. Если VIN не распознан,
 * интерфейс предлагает выбрать класс вручную — это равноценный путь,
 * а не аварийный.
 *
 * @module js/vin/data
 */

/** @typedef {'high'|'medium'|'low'} Confidence */

/**
 * Символы 1–3 VIN (WMI) → производитель и регион сборки.
 * Суффикс '*' работает как подстановочный знак: 'XW*' покрывает XW0…XW9.
 *
 * @type {Record<string, {make: string, makeEn: string, region: string}>}
 */
export const WMI_TABLE = {
  // ─── Россия и СНГ ───────────────────────────────────────────────────────
  XTA: { make: 'Лада', makeEn: 'Lada', region: 'RU' },
  XW8: { make: 'Volkswagen', makeEn: 'Volkswagen', region: 'RU' },
  XWE: { make: 'АвтоВАЗ', makeEn: 'AvtoVAZ', region: 'RU' },
  X9F: { make: 'ГАЗ', makeEn: 'GAZ', region: 'RU' },
  X4X: { make: 'Автотор', makeEn: 'Avtotor', region: 'RU' },
  XUU: { make: 'Chevrolet', makeEn: 'Chevrolet', region: 'RU' },
  X7L: { make: 'Renault', makeEn: 'Renault', region: 'RU' },
  X96: { make: 'ГАЗ', makeEn: 'GAZ', region: 'RU' },
  Y6D: { make: 'ЗАЗ', makeEn: 'ZAZ', region: 'UA' },
  UU1: { make: 'Dacia', makeEn: 'Dacia', region: 'RO' },

  // ─── Германия ───────────────────────────────────────────────────────────
  WVW: { make: 'Volkswagen', makeEn: 'Volkswagen', region: 'DE' },
  WV1: { make: 'Volkswagen', makeEn: 'Volkswagen', region: 'DE' },
  WV2: { make: 'Volkswagen', makeEn: 'Volkswagen', region: 'DE' },
  WVG: { make: 'Volkswagen', makeEn: 'Volkswagen', region: 'DE' },
  WAU: { make: 'Audi', makeEn: 'Audi', region: 'DE' },
  WAP: { make: 'Audi', makeEn: 'Audi', region: 'DE' },
  WUA: { make: 'Audi', makeEn: 'Audi', region: 'DE' },
  WBA: { make: 'BMW', makeEn: 'BMW', region: 'DE' },
  WBS: { make: 'BMW M', makeEn: 'BMW M', region: 'DE' },
  WBY: { make: 'BMW i', makeEn: 'BMW i', region: 'DE' },
  WDD: { make: 'Mercedes-Benz', makeEn: 'Mercedes-Benz', region: 'DE' },
  WDB: { make: 'Mercedes-Benz', makeEn: 'Mercedes-Benz', region: 'DE' },
  WDC: { make: 'Mercedes-Benz', makeEn: 'Mercedes-Benz', region: 'DE' },
  WDF: { make: 'Mercedes-Benz', makeEn: 'Mercedes-Benz', region: 'DE' },
  WMX: { make: 'Mercedes-AMG', makeEn: 'Mercedes-AMG', region: 'DE' },
  WP0: { make: 'Porsche', makeEn: 'Porsche', region: 'DE' },
  WP1: { make: 'Porsche', makeEn: 'Porsche', region: 'DE' },
  W0L: { make: 'Opel', makeEn: 'Opel', region: 'DE' },
  W0V: { make: 'Opel', makeEn: 'Opel', region: 'DE' },
  WOL: { make: 'Opel', makeEn: 'Opel', region: 'DE' },
  WSM: { make: 'Škoda', makeEn: 'Skoda', region: 'DE' },
  TMB: { make: 'Škoda', makeEn: 'Skoda', region: 'CZ' },
  TMP: { make: 'Škoda', makeEn: 'Skoda', region: 'CZ' },
  VSS: { make: 'SEAT', makeEn: 'SEAT', region: 'ES' },
  WF0: { make: 'Ford', makeEn: 'Ford', region: 'DE' },
  WF1: { make: 'Ford', makeEn: 'Ford', region: 'DE' },

  // ─── Франция ────────────────────────────────────────────────────────────
  VF1: { make: 'Renault', makeEn: 'Renault', region: 'FR' },
  VF3: { make: 'Peugeot', makeEn: 'Peugeot', region: 'FR' },
  VF6: { make: 'Renault Trucks', makeEn: 'Renault Trucks', region: 'FR' },
  VF7: { make: 'Citroën', makeEn: 'Citroen', region: 'FR' },
  VF8: { make: 'Citroën', makeEn: 'Citroen', region: 'FR' },
  VR1: { make: 'DS Automobiles', makeEn: 'DS Automobiles', region: 'FR' },
  VGA: { make: 'Peugeot', makeEn: 'Peugeot', region: 'FR' },
  VF9: { make: 'Bugatti', makeEn: 'Bugatti', region: 'FR' },

  // ─── Италия ─────────────────────────────────────────────────────────────
  ZFA: { make: 'Fiat', makeEn: 'Fiat', region: 'IT' },
  ZFC: { make: 'Fiat', makeEn: 'Fiat', region: 'IT' },
  ZAR: { make: 'Alfa Romeo', makeEn: 'Alfa Romeo', region: 'IT' },
  ZAM: { make: 'Maserati', makeEn: 'Maserati', region: 'IT' },
  ZFF: { make: 'Ferrari', makeEn: 'Ferrari', region: 'IT' },
  ZHW: { make: 'Lamborghini', makeEn: 'Lamborghini', region: 'IT' },
  ZLA: { make: 'Lancia', makeEn: 'Lancia', region: 'IT' },

  // ─── Великобритания ─────────────────────────────────────────────────────
  SAJ: { make: 'Jaguar', makeEn: 'Jaguar', region: 'GB' },
  SAL: { make: 'Land Rover', makeEn: 'Land Rover', region: 'GB' },
  SAD: { make: 'Land Rover', makeEn: 'Land Rover', region: 'GB' },
  SCF: { make: 'Aston Martin', makeEn: 'Aston Martin', region: 'GB' },
  SCB: { make: 'Bentley', makeEn: 'Bentley', region: 'GB' },
  SCA: { make: 'Rolls-Royce', makeEn: 'Rolls-Royce', region: 'GB' },
  SCC: { make: 'Lotus', makeEn: 'Lotus', region: 'GB' },

  // ─── Швеция ─────────────────────────────────────────────────────────────
  YV1: { make: 'Volvo', makeEn: 'Volvo', region: 'SE' },
  YV4: { make: 'Volvo', makeEn: 'Volvo', region: 'SE' },
  YS3: { make: 'Saab', makeEn: 'Saab', region: 'SE' },

  // ─── Япония ─────────────────────────────────────────────────────────────
  JHM: { make: 'Honda', makeEn: 'Honda', region: 'JP' },
  JHL: { make: 'Honda', makeEn: 'Honda', region: 'JP' },
  JHF: { make: 'Honda', makeEn: 'Honda', region: 'JP' },
  JTM: { make: 'Toyota', makeEn: 'Toyota', region: 'JP' },
  JTE: { make: 'Toyota', makeEn: 'Toyota', region: 'JP' },
  JTH: { make: 'Lexus', makeEn: 'Lexus', region: 'JP' },
  JTJ: { make: 'Lexus', makeEn: 'Lexus', region: 'JP' },
  JN1: { make: 'Nissan', makeEn: 'Nissan', region: 'JP' },
  JN6: { make: 'Nissan', makeEn: 'Nissan', region: 'JP' },
  JNK: { make: 'Infiniti', makeEn: 'Infiniti', region: 'JP' },
  JM1: { make: 'Mazda', makeEn: 'Mazda', region: 'JP' },
  JM3: { make: 'Mazda', makeEn: 'Mazda', region: 'JP' },
  JF1: { make: 'Subaru', makeEn: 'Subaru', region: 'JP' },
  JF2: { make: 'Subaru', makeEn: 'Subaru', region: 'JP' },
  JA3: { make: 'Mitsubishi', makeEn: 'Mitsubishi', region: 'JP' },
  JA4: { make: 'Mitsubishi', makeEn: 'Mitsubishi', region: 'JP' },
  JS2: { make: 'Suzuki', makeEn: 'Suzuki', region: 'JP' },
  JSA: { make: 'Suzuki', makeEn: 'Suzuki', region: 'JP' },
  JMB: { make: 'Mitsubishi', makeEn: 'Mitsubishi', region: 'JP' },
  JDA: { make: 'Daihatsu', makeEn: 'Daihatsu', region: 'JP' },

  // ─── Южная Корея ────────────────────────────────────────────────────────
  KMH: { make: 'Hyundai', makeEn: 'Hyundai', region: 'KR' },
  KM8: { make: 'Hyundai', makeEn: 'Hyundai', region: 'KR' },
  KNA: { make: 'Kia', makeEn: 'Kia', region: 'KR' },
  KNB: { make: 'Kia', makeEn: 'Kia', region: 'KR' },
  KND: { make: 'Kia', makeEn: 'Kia', region: 'KR' },
  KPB: { make: 'SsangYong', makeEn: 'SsangYong', region: 'KR' },
  KPT: { make: 'SsangYong', makeEn: 'SsangYong', region: 'KR' },
  KLA: { make: 'Daewoo', makeEn: 'Daewoo', region: 'KR' },
  KL1: { make: 'Chevrolet', makeEn: 'Chevrolet', region: 'KR' },

  // ─── США ────────────────────────────────────────────────────────────────
  '1HG': { make: 'Honda', makeEn: 'Honda', region: 'US' },
  '1FA': { make: 'Ford', makeEn: 'Ford', region: 'US' },
  '1FB': { make: 'Ford', makeEn: 'Ford', region: 'US' },
  '1FC': { make: 'Ford', makeEn: 'Ford', region: 'US' },
  '1FD': { make: 'Ford', makeEn: 'Ford', region: 'US' },
  '1FM': { make: 'Ford', makeEn: 'Ford', region: 'US' },
  '1FT': { make: 'Ford', makeEn: 'Ford', region: 'US' },
  '1G1': { make: 'Chevrolet', makeEn: 'Chevrolet', region: 'US' },
  '1GC': { make: 'Chevrolet', makeEn: 'Chevrolet', region: 'US' },
  '1GT': { make: 'GMC', makeEn: 'GMC', region: 'US' },
  '1C3': { make: 'Chrysler', makeEn: 'Chrysler', region: 'US' },
  '1C4': { make: 'Jeep', makeEn: 'Jeep', region: 'US' },
  '1C6': { make: 'Ram', makeEn: 'Ram', region: 'US' },
  '1D3': { make: 'Dodge', makeEn: 'Dodge', region: 'US' },
  '1D4': { make: 'Dodge', makeEn: 'Dodge', region: 'US' },
  '1D7': { make: 'Dodge', makeEn: 'Dodge', region: 'US' },
  '1J4': { make: 'Jeep', makeEn: 'Jeep', region: 'US' },
  '1J8': { make: 'Jeep', makeEn: 'Jeep', region: 'US' },
  '1B3': { make: 'Dodge', makeEn: 'Dodge', region: 'US' },
  '1N4': { make: 'Nissan', makeEn: 'Nissan', region: 'US' },
  '1N6': { make: 'Nissan', makeEn: 'Nissan', region: 'US' },
  '1VW': { make: 'Volkswagen', makeEn: 'Volkswagen', region: 'US' },
  '1YV': { make: 'Mazda', makeEn: 'Mazda', region: 'US' },
  '1ZV': { make: 'Ford', makeEn: 'Ford', region: 'US' },
  '4T1': { make: 'Toyota', makeEn: 'Toyota', region: 'US' },
  '4T3': { make: 'Toyota', makeEn: 'Toyota', region: 'US' },
  '4S3': { make: 'Subaru', makeEn: 'Subaru', region: 'US' },
  '4S4': { make: 'Subaru', makeEn: 'Subaru', region: 'US' },
  '5FN': { make: 'Honda', makeEn: 'Honda', region: 'US' },
  '5TD': { make: 'Toyota', makeEn: 'Toyota', region: 'US' },
  '5YJ': { make: 'Tesla', makeEn: 'Tesla', region: 'US' },
  '7SA': { make: 'Tesla', makeEn: 'Tesla', region: 'US' },

  // ─── Канада и Мексика ───────────────────────────────────────────────────
  '2HG': { make: 'Honda', makeEn: 'Honda', region: 'CA' },
  '2T1': { make: 'Toyota', makeEn: 'Toyota', region: 'CA' },
  '2C4': { make: 'Chrysler', makeEn: 'Chrysler', region: 'CA' },
  '3VW': { make: 'Volkswagen', makeEn: 'Volkswagen', region: 'MX' },
  '3N1': { make: 'Nissan', makeEn: 'Nissan', region: 'MX' },
  '3FA': { make: 'Ford', makeEn: 'Ford', region: 'MX' },
  '3G1': { make: 'Chevrolet', makeEn: 'Chevrolet', region: 'MX' },

  // ─── Китай ──────────────────────────────────────────────────────────────
  LFV: { make: 'Volkswagen', makeEn: 'Volkswagen', region: 'CN' },
  LSV: { make: 'Volkswagen', makeEn: 'Volkswagen', region: 'CN' },
  LGB: { make: 'Geely', makeEn: 'Geely', region: 'CN' },
  LVX: { make: 'Geely', makeEn: 'Geely', region: 'CN' },
  LJD: { make: 'Chery', makeEn: 'Chery', region: 'CN' },
  LVV: { make: 'Chery', makeEn: 'Chery', region: 'CN' },
  LS5: { make: 'Haval', makeEn: 'Haval', region: 'CN' },
  LGX: { make: 'BYD', makeEn: 'BYD', region: 'CN' },
  LNB: { make: 'Changan', makeEn: 'Changan', region: 'CN' },
  LSF: { make: 'FAW', makeEn: 'FAW', region: 'CN' },
  LFP: { make: 'FAW', makeEn: 'FAW', region: 'CN' },
  LB2: { make: 'Geely', makeEn: 'Geely', region: 'CN' },
};

/**
 * Подстановочные правила WMI: применяются, если точного совпадения нет.
 * @type {Array<{prefix: string, make: string, makeEn: string, region: string}>}
 */
export const WMI_WILDCARDS = [
  { prefix: 'XW', make: 'АвтоВАЗ', makeEn: 'AvtoVAZ', region: 'RU' },
  { prefix: 'X9', make: 'ГАЗ', makeEn: 'GAZ', region: 'RU' },
  { prefix: 'L', make: 'Китай', makeEn: 'China', region: 'CN' },
];

/**
 * Кодировка 10-го символа VIN → год выпуска.
 * Коды повторяются каждые 30 лет, поэтому таблица разделена на две эпохи.
 *
 * @type {{before2010: Record<string, number>, after2010: Record<string, number>}}
 */
export const YEAR_CODES = {
  /** Коды для автомобилей 1980–2009 годов. */
  before2010: {
    A: 1980, B: 1981, C: 1982, D: 1983, E: 1984, F: 1985, G: 1986, H: 1987,
    J: 1988, K: 1989, L: 1990, M: 1991, N: 1992, P: 1993, R: 1994, S: 1995,
    T: 1996, V: 1997, W: 1998, X: 1999, Y: 2000, '1': 2001, '2': 2002,
    '3': 2003, '4': 2004, '5': 2005, '6': 2006, '7': 2007, '8': 2008, '9': 2009,
  },
  /** Коды для автомобилей 2010–2039 годов. */
  after2010: {
    A: 2010, B: 2011, C: 2012, D: 2013, E: 2014, F: 2015, G: 2016, H: 2017,
    J: 2018, K: 2019, L: 2020, M: 2021, N: 2022, P: 2023, R: 2024, S: 2025,
    T: 2026, V: 2027, W: 2028, X: 2029, Y: 2030, '1': 2031, '2': 2032,
    '3': 2033, '4': 2034, '5': 2035, '6': 2036, '7': 2037, '8': 2038, '9': 2039,
  },
};

/**
 * Символы 4–8 VIN → модель автомобиля.
 * Таблица намеренно неполная: у европейских и японских марок здесь часто
 * стоит код кузова или двигателя, а не модель. Наличие записи даёт
 * высокую достоверность, отсутствие — не ошибка, а повод выбрать класс вручную.
 *
 * @type {Record<string, {makeEn: string, model: string, confidence: Confidence}>}
 */
export const MODEL_PREFIXES = {
  // Honda
  CM826: { makeEn: 'Honda', model: 'Accord', confidence: 'high' },
  CM828: { makeEn: 'Honda', model: 'Accord', confidence: 'high' },
  CM835: { makeEn: 'Honda', model: 'Accord', confidence: 'high' },
  ES158: { makeEn: 'Honda', model: 'Civic', confidence: 'high' },
  FC2F1: { makeEn: 'Honda', model: 'Civic', confidence: 'high' },
  // Toyota
  BK3EK: { makeEn: 'Toyota', model: 'Camry', confidence: 'high' },
  BE1EP: { makeEn: 'Toyota', model: 'Camry', confidence: 'high' },
  AE0U0: { makeEn: 'Toyota', model: 'Corolla', confidence: 'high' },
  RE1E1: { makeEn: 'Toyota', model: 'Land Cruiser', confidence: 'medium' },
  RF1E1: { makeEn: 'Toyota', model: 'RAV4', confidence: 'medium' },
  // Volkswagen
  ZZZ1J: { makeEn: 'Volkswagen', model: 'Golf', confidence: 'medium' },
  ZZZ3C: { makeEn: 'Volkswagen', model: 'Passat', confidence: 'medium' },
  ZZZ7L: { makeEn: 'Volkswagen', model: 'Touareg', confidence: 'medium' },
  // Mercedes-Benz
  '2202': { makeEn: 'Mercedes-Benz', model: 'S-Class', confidence: 'low' },
  // Hyundai / Kia
  H81BM: { makeEn: 'Hyundai', model: 'Solaris', confidence: 'medium' },
  H0D14: { makeEn: 'Hyundai', model: 'Tucson', confidence: 'medium' },
  M81AB: { makeEn: 'Kia', model: 'Rio', confidence: 'medium' },
  // BMW
  '1102': { makeEn: 'BMW', model: '3 Series', confidence: 'low' },
  // Лада
  21150: { makeEn: 'Lada', model: '2115', confidence: 'medium' },
  21901: { makeEn: 'Lada', model: 'Granta', confidence: 'medium' },
  21921: { makeEn: 'Lada', model: 'Vesta', confidence: 'medium' },
};

/**
 * Класс автомобиля 1–5 по названию модели.
 * Порядок проверки важен: от специфичного к общему — иначе «X5» попадёт
 * в общее правило раньше, чем в правило класса 4.
 *
 * @type {Array<{class: number, match: string[], reason: string}>}
 */
export const CLASS_TABLE = [
  { class: 5, match: ['Huracan', 'Aventador', 'Gallardo', '911', 'R8', 'G-Class', 'LX', 'X7', 'GLS', 'Continental', 'Phantom', 'Ghost', 'Aventador', 'Ferrari', 'F8', '488', 'Model S', 'Model X', 'Taycan'], reason: 'exotic' },
  { class: 4, match: ['5 Series', 'E-Class', 'S-Class', 'Q7', 'Q8', 'X5', 'X6', 'Touareg', 'Land Cruiser', 'GLE', 'GLS', 'Prado', 'RX', 'GX', 'A6', 'A8', '7 Series', 'Cayenne', 'Panamera', 'Cayenne', 'Passat', 'Monjaro'], reason: 'premium-large' },
  { class: 3, match: ['Camry', 'RAV4', 'CR-V', 'Tucson', 'Santa Fe', 'Sportage', 'Sorento', 'Passat', 'Sorento', 'X-Trail', 'Qashqai', 'Outlander', 'Forester', 'CX-5', 'Tiguan', 'Kuga', 'Duster', 'Haval'], reason: 'suv-mid' },
  { class: 2, match: ['Accord', 'Corolla', 'Civic', 'Elantra', 'Focus', 'Octavia', 'Jetta', 'Solaris', 'Rio', 'Cruze', 'Astra', 'Mazda 3', "Cee'd", 'Cerato', 'Rapid', 'Vesta', 'Granta', 'Priora', '2115', '2114'], reason: 'sedan' },
  { class: 1, match: ['Picanto', 'Spark', 'Aygo', 'Up!', 'Fiat 500', 'Ka', 'Twingo', 'IQ', 'C1', '107', 'Aygo'], reason: 'compact' },
];

/**
 * Множители классов 1–5. Значения синхронизированы с CONFIG.pricing.classMultipliers
 * и приведены здесь для автономного использования модуля без обращения к конфигу.
 *
 * @type {Record<number, number>}
 */
export const MULTIPLIERS = { 1: 0.75, 2: 1.0, 3: 1.15, 4: 1.55, 5: 2.1 };

/**
 * Человекочитаемые названия классов. Используются в модулях, которым
 * недоступен словарь (например, при формировании сообщения менеджеру).
 *
 * @type {Record<number, {ru: string, hy: string}>}
 */
export const CLASS_LABELS = {
  1: { ru: 'Компакт', hy: 'Կոմպակտ' },
  2: { ru: 'Седан, малый кроссовер', hy: 'Սեդան, փոքր քրոսովեր' },
  3: { ru: 'Кроссовер, внедорожник', hy: 'Քրոսովեր, ամենագնաց' },
  4: { ru: 'Премиум, крупный внедорожник', hy: 'Պրեմիում, խոշոր ամենագնաց' },
  5: { ru: 'Эксклюзив, суперкар', hy: 'Էքսկլյուզիվ, սուպերմեքենա' },
};
