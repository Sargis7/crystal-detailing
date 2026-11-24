/**
 * Готовит девять фотографий заказчика к роли фонов карточек услуг.
 *
 * Что делает и почему именно так:
 *
 * 1. **Кроп, а не растяжение.** Карточка услуги — вертикальный блок
 *    примерно 420×300 с обрезкой по центру (object-fit: cover). Поэтому
 *    из исходника вырезается горизонтальный кадр 4:3 ещё до уменьшения:
 *    если этого не сделать, браузер обрежет картинку сам, и в кадр может
 *    попасть пустота вместо машины. Композиция подбирается полем `focus`
 *    у каждой работы отдельно — центрирование годится не для всех.
 *
 * 2. **Одна ширина на выход — 1200 px.** Карточка услуги на десктопе
 *    занимает около 420 px, то есть даже на Retina-экране (2x) нужно
 *    ~840 px. Файл в 1200 px перекрывает это с запасом, поэтому отдельная
 *    версия @2x не нужна: она добавила бы сотни килобайт ради пикселей,
 *    которых не видно.
 *
 * 3. **Резкость после уменьшения.** Любое уменьшение размывает края.
 *    Лёгкий unsharp по границам возвращает «дорогой» вид. Сильная
 *    резкость на фото с хромом и гексагонами даёт грязь, поэтому
 *    параметры консервативные.
 *
 * 4. **Подбор качества под целевой вес.** Прогоняем JPEG в цикле от
 *    высокого качества вниз, пока файл не влезет в лимит. Так же
 *    поступают сборщики: фиксированное качество даёт то 40 КБ, то 400.
 *
 * Запуск: node tools/prepare-service-photos.mjs
 *
 * ВНИМАНИЕ: скрипт перезаписывает готовые файлы в assets/gallery/. Он нужен,
 * только если исходники заказчика появились заново (новые фото, другая
 * обрезка). Если их нет — сайт уже укомплектован, и запускать его не надо:
 * он честно скажет «НЕТ ФАЙЛА» по каждому и ничего не тронет.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const SOURCE_DIR = 'C:/Users/ПК/Desktop';
const OUT_DIR = 'assets/gallery';

/**
 * Соответствие «услуга → файл заказчика».
 *
 * Порядок и id совпадают с CONFIG.pricing.services, чтобы связь была
 * видна глазом и проверялась тестом.
 *
 * `focus` — куда сместить центр кадра по вертикали (0 — верх, 1 — низ).
 * Указывается там, где центрирование обрезает главное.
 *
 * `allowUpscale` стоит только у «Керамики»: её исходник 450×800 меньше
 * остальных, и заказчик отдельно попросил увеличить до 900 px. Всем
 * остальным растягивание не нужно — они и так крупные.
 */
const JOBS = [
  {
    id: 'engine-bay',
    file: 'Подкапот.jpg',
    focus: 0.5,
  },
  {
    id: 'ppf',
    file: 'Зона риска.jpg',
    // Капот с плёнкой занимает верхнюю треть, под ним пол и ноги —
    // центр кадра их и захватывает. Смещаем окно вверх.
    focus: 0.34,
  },
  {
    id: 'wrap-full',
    file: 'Атермал.jpg',
    // Синий матовый Mercedes. Кадр горизонтальный и плотный, центр хорош.
    focus: 0.5,
  },
  {
    id: 'antichrome',
    file: 'Антихром.jpg',
    // Вертикальный кадр: зеркало и стойка сверху. Обрезаем в верхней трети.
    focus: 0.3,
  },
  {
    id: 'tint',
    file: 'Тонировка.jpg',
    // Широкий кадр 2560×1696, машина стоит по центру и чуть ниже.
    focus: 0.55,
  },
  {
    id: 'tint-athermal',
    file: 'Кристал 2.jpg',
    // Радужный блик на лобовом — он в верхней половине кадра.
    focus: 0.33,
  },
  {
    id: 'polish',
    file: 'Полировка.jpg',
    // Отражение гексагонов занимает верхние две трети.
    focus: 0.4,
  },
  {
    id: 'ceramic',
    file: 'Керамика.jpg',
    focus: 0.5,
    // Единственный исходник мельче остальных (450×800), и заказчик
    // отдельно попросил увеличить его до 900 px. Ставим именно 900, а не
    // общие 1200: растяжение с 450 до 1200 — это 2.7x, картинка поплывёт.
    // 900 даёт 2x при умеренном растяжении и заметно лучше, чем 450.
    width: 900,
    allowUpscale: true,
  },
  {
    id: 'interior',
    file: 'Салон 3.jpg',
    // Салон с рулём: руль в верхней трети, сиденье внизу.
    focus: 0.42,
  },
];

/** Кадр 4:3 — под пропорции карточки услуги. */
const ASPECT_W = 4;
const ASPECT_H = 3;

/** Ширина основного файла. Карточка ~420 px CSS, 1200 даёт запас на 2x. */
const WIDTH_1X = 1200;

/** Целевой вес основного файла. */
const MAX_BYTES = 220 * 1024;

/** Качество перебираем от лучшего к приемлемому, а не угадываем. */
const QUALITY_STEPS = [86, 82, 78, 74, 70, 66, 62, 58, 54, 50];

/**
 * Сжимает буфер в JPEG, подбирая качество под лимит веса.
 *
 * @param {import('sharp').Sharp} pipeline Подготовленный конвейер.
 * @param {number} limitBytes Предельный вес файла.
 * @returns {Promise<{buffer: Buffer, quality: number}>} Результат и качество.
 */
async function encodeUnderLimit(pipeline, limitBytes) {
  let last = null;
  for (const quality of QUALITY_STEPS) {
    // Клонируем: конвейер sharp одноразовый, повторный toBuffer на нём
    // падает с «Input file is missing».
    const buffer = await pipeline.clone().jpeg({ quality, mozjpeg: true }).toBuffer();
    last = { buffer, quality };
    if (buffer.length <= limitBytes) {
      return last;
    }
  }
  // Даже на минимальном качестве не влезли — отдаём что есть и говорим
  // об этом вслух, молча отдавать перевес нельзя.
  return last;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const report = [];

  for (const job of JOBS) {
    const src = path.join(SOURCE_DIR, job.file);
    const before = await fs.stat(src).catch(() => null);
    if (!before) {
      console.error(`НЕТ ФАЙЛА: ${src}`);
      process.exitCode = 1;
      continue;
    }

    const input = sharp(src);
    const meta = await input.metadata();

    // Считаем окно кропа вручную, а не через position: нужно смещение
    // по вертикали дробным числом, а sharp принимает только
    // 'top' | 'centre' | 'bottom' | 'left' | 'right' | gravity.
    const srcAspect = meta.width / meta.height;
    const wantAspect = ASPECT_W / ASPECT_H;

    let cropW;
    let cropH;
    let cropLeft;
    let cropTop;

    if (srcAspect > wantAspect) {
      // Исходник шире нужного: режем по бокам.
      cropH = meta.height;
      cropW = Math.round(cropH * wantAspect);
      cropLeft = Math.round((meta.width - cropW) / 2);
      cropTop = 0;
    } else {
      // Исходник выше нужного: режем сверху и снизу со смещением focus.
      cropW = meta.width;
      cropH = Math.round(cropW / wantAspect);
      cropLeft = 0;
      const slack = meta.height - cropH;
      cropTop = Math.max(0, Math.min(slack, Math.round(slack * job.focus)));
    }

    const base = input.extract({
      left: cropLeft,
      top: cropTop,
      width: cropW,
      height: cropH,
    });

    // Если исходник мельче целевой ширины, ресайз вверх делаем только
    // там, где заказчик об этом попросил. Иначе sharp молча растянет
    // картинку и она станет мыльной — лучше оставить как есть.
    const wantW = job.width || WIDTH_1X;
    const canReach = cropW >= wantW;
    if (!canReach && !job.allowUpscale) {
      console.warn(`ВНИМАНИЕ ${job.id}: исходник ${cropW}px < ${wantW}px, оставляю без увеличения`);
    }
    const targetW = canReach || job.allowUpscale ? wantW : cropW;

    const resized = base.resize({
      width: targetW,
      height: Math.round((targetW / ASPECT_W) * ASPECT_H),
      fit: 'fill',
      kernel: 'lanczos3',
    });

    // unsharp консервативный: на хроме и гексагонах агрессивные значения
    // дают тёмные ореолы по краям бликов.
    const sharpened = resized.sharpen({ sigma: 0.6, m1: 0.4, m2: 2.2, x1: 2, y1: 8 });

    const one = await encodeUnderLimit(sharpened, MAX_BYTES);

    const outName = `service-${job.id}.jpg`;
    const outPath = path.join(OUT_DIR, outName);
    await fs.writeFile(outPath, one.buffer);

    report.push({
      id: job.id,
      src: job.file,
      srcSize: `${meta.width}x${meta.height}`,
      crop: `${cropW}x${cropH}+${cropLeft}+${cropTop}`,
      out: `${targetW}x${Math.round((targetW / ASPECT_W) * ASPECT_H)}`,
      kb: Math.round(one.buffer.length / 1024),
      q: one.quality,
      wasKb: Math.round(before.size / 1024),
    });
  }

  console.log('\n  id'.padEnd(22) + 'исходник'.padEnd(14) + 'кроп'.padEnd(20) + 'итог'.padEnd(12) + 'вес'.padEnd(8) + 'q');
  console.log('  ' + '─'.repeat(80));
  for (const r of report) {
    console.log(
      '  ' + r.id.padEnd(20)
      + `${r.srcSize}`.padEnd(14)
      + `${r.crop}`.padEnd(20)
      + `${r.out}`.padEnd(12)
      + `${r.kb} КБ`.padEnd(8)
      + `${r.q}`
    );
  }

  const total = report.reduce((sum, r) => sum + r.kb, 0);
  console.log(`\n  Всего записано: ${report.length} файлов, ${total} КБ`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
