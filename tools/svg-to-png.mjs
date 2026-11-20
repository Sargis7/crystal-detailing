#!/usr/bin/env node
/**
 * Растеризация SVG в PNG без внешних зависимостей — через headless Chrome.
 *
 * Зачем: в системе нет ни ImageMagick, ни Inkscape, ни rsvg-convert, а логотип
 * нужно отдать в PNG (мессенджеры не показывают SVG превью).
 *
 * Chrome запускается один раз на все размеры, страница открывается из file://.
 * Прозрачность сохраняется флагом --default-background-color=00000000.
 *
 * Использование:
 *   node tools/svg-to-png.mjs <input.svg> <out-dir> <size,size,...>
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [inputArg, outArg, sizesArg] = process.argv.slice(2);

if (!inputArg || !outArg || !sizesArg) {
  console.error('Использование: node tools/svg-to-png.mjs <input.svg> <out-dir> <size,size,...>');
  process.exit(1);
}

const input = resolve(root, inputArg);
if (!existsSync(input)) {
  console.error(`Нет файла: ${input}`);
  process.exit(1);
}

const outDir = resolve(root, outArg);
mkdirSync(outDir, { recursive: true });

const sizes = sizesArg.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => n > 0);
if (!sizes.length) {
  console.error('Не указаны размеры');
  process.exit(1);
}

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error('Chrome не найден. Установите Chrome или укажите путь в CHROME_CANDIDATES.');
  process.exit(1);
}

// Страница-обёртка: SVG вставлен инлайном и растянут на весь вьюпорт,
// поэтому размер скриншота ровно равен запрошенному размеру PNG.
const svgSource = (await import('node:fs')).readFileSync(input, 'utf8');
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden}
svg{display:block;width:100vw;height:100vh}
</style></head><body>${svgSource.replace(/<\?xml[^>]*\?>/g, '')}</body></html>`;

const htmlPath = join(outDir, '_render.html');
writeFileSync(htmlPath, html, 'utf8');
const pageUrl = pathToFileURL(htmlPath).href;

for (const size of sizes) {
  const target = join(outDir, `logo-mark-${size}.png`);
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--default-background-color=00000000',
    '--force-device-scale-factor=1',
    `--window-size=${size},${size}`,
    `--screenshot=${target}`,
    '--virtual-time-budget=1500',
    pageUrl,
  ];
  const code = await new Promise((res) => {
    const child = spawn(chrome, args, { stdio: 'ignore' });
    child.on('exit', res);
    child.on('error', () => res(-1));
  });
  console.log(`${code === 0 && existsSync(target) ? 'OK ' : 'FAIL'} ${target}`);
}

// Обёртку убираем: это служебный файл, ему не место среди ассетов.
(await import('node:fs')).unlinkSync(htmlPath);
