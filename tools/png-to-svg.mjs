#!/usr/bin/env node
/**
 * Обёртка PNG в SVG: растровые данные кладутся внутрь <image>, файл
 * остаётся вектором по контейнеру, но картинка внутри — пиксели.
 *
 * Зачем это нужно, если есть сам PNG: <img src="*.svg"> в шапке получает
 * width/height из viewBox и масштабируется по CSS без «прыжка» при загрузке,
 * плюс появляется место для <title> и описания бренда.
 *
 * ВАЖНО: это не трассировка. Контур машины остаётся растровым — при
 * увеличении он мягчает. Если понадобится печатный вектор, логотип надо
 * перерисовать в кривые, а не конвертировать.
 *
 * Использование: node tools/png-to-svg.mjs <in.png> <out.svg> [ширина] [высота]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [src, dst, wArg, hArg] = process.argv.slice(2);
if (!src || !dst) {
  console.error('Использование: node tools/png-to-svg.mjs <in.png> <out.svg> [ширина] [высота]');
  process.exit(1);
}

const png = readFileSync(src);
// Размеры берём из IHDR — единственное место, где они лежат достоверно.
const w = wArg ? Number(wArg) : png.readUInt32BE(16);
const h = hArg ? Number(hArg) : png.readUInt32BE(20);
const b64 = png.toString('base64');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <image x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"
         href="data:image/png;base64,${b64}"/>
</svg>
`;

writeFileSync(dst, svg, 'utf8');
console.log(`${dst}  ${w}×${h}  ${(svg.length / 1024).toFixed(0)} KB`);
