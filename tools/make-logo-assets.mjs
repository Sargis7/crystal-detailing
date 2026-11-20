#!/usr/bin/env node
/**
 * Собирает знак бренда из присланного логотипа Crystal Detailing
 * (brand/_source-logo.png — синий силуэт машины, белая надпись CRYSTAL,
 * синяя DETAILING на прозрачном фоне).
 *
 * Почему так, а не «просто скопировать файл»:
 *  - в исходнике надпись CRYSTAL белая, на светлом фоне её не видно;
 *  - отпечаток исходника 1080×800 с большими пустыми полями, в шапке 40×40
 *    от него останется точка;
 *  - под тёмную тему сайта нужна инверсия: белая надпись читается, синий
 *    силуэт на почти чёрном фоне — нет.
 *
 * Поэтому здесь один раз считается альфа-маска (по непрозрачности), затем
 * из неё перекрашиваются все варианты. Надпись CRYSTAL определяется как
 * «все непрозрачные пиксели выше y=430» — она отделена от машины зазором.
 *
 * Результат:
 *   assets/logo-mark.svg      — знак для шапки (силуэт, светлый)
 *   assets/logo-lockup.svg    — полный логотип (машина + CRYSTAL + DETAILING)
 *   brand/logo-*.png          — растры для мессенджеров и печати
 */
import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

const SRC = 'brand/_source-logo.png';

/** Разбор PNG в RGBA-буфер без сторонних зависимостей. */
function decode(file) {
  const buf = readFileSync(file);
  let p = 8, w = 0, h = 0, bd = 0, ct = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IHDR') { w = buf.readUInt32BE(p + 8); h = buf.readUInt32BE(p + 12); bd = buf[p + 16]; ct = buf[p + 17]; }
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  if (bd !== 8 || (ct !== 6 && ct !== 2)) {
    throw new Error(`Ожидается 8-битный RGBA/RGB, получено bd=${bd} ct=${ct}`);
  }
  const ch = ct === 6 ? 4 : 3;
  const stride = w * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride), off = 0, o = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[off++];
    const line = raw.subarray(off, off + stride); off += stride;
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      px[o++] = cur[x * ch];
      px[o++] = cur[x * ch + 1];
      px[o++] = cur[x * ch + 2];
      px[o++] = ch === 4 ? cur[x * ch + 3] : 255;
    }
    prev = cur;
  }
  return { w, h, px };
}

/** PNG обратно из RGBA (фильтр 0 — без предсказаний, файл небольшой). */
function encode(w, h, px) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc = (b) => {
    let c = 0xFFFFFFFF;
    for (const byte of b) c = crcTable[(c ^ byte) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, cr]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PAD = 8;
// Непрозрачность ниже ALPHA_MIN — это шум сжатия и едва заметная тень
// слова CRYSTAL, попавшая в кропп машины. Обрезаем её, иначе в знаке
// остаётся «призрак» надписи.
const ALPHA_MIN = 40;

const src = decode(SRC);
console.log(`исходник: ${src.w}×${src.h}`);

// ── Разделяем машину и надписи по вертикали ────────────────────────────────
// Профиль непрозрачности исходника (1080×800):
//   машина      y ≈ 175…332
//   пустая полоса y ≈ 333…344
//   CRYSTAL     y ≈ 345…470   (белая, на белом фоне не видна)
//   пустая полоса y ≈ 471…505
//   DETAILING   y ≈ 506…625   (синяя)
// Граница ставится в ПЕРВУЮ пустую полосу. Если поставить её внутрь слова
// CRYSTAL (первая попытка была на 424), в знак машины попадает «призрак»
// надписи — она белая, поэтому её не видно в превью, но она есть в альфе.
const SPLIT = 338;
const bbox = (y0, y1) => {
  let x0 = 1e9, x1 = -1, yy0 = 1e9, yy1 = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < src.w; x++) {
      if (src.px[(y * src.w + x) * 4 + 3] > ALPHA_MIN) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < yy0) yy0 = y; if (y > yy1) yy1 = y;
      }
    }
  }
  return { x0, x1, y0: yy0, y1: yy1 };
};

const carBox = bbox(0, SPLIT);
const textBox = bbox(SPLIT, src.h);
console.log('машина:', carBox, 'надписи:', textBox);

const crop = (b) => {
  const x0 = Math.max(0, b.x0 - PAD), x1 = Math.min(src.w - 1, b.x1 + PAD);
  const y0 = Math.max(0, b.y0 - PAD), y1 = Math.min(src.h - 1, b.y1 + PAD);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    src.px.copy(px, y * w * 4, ((y0 + y) * src.w + x0) * 4, ((y0 + y) * src.w + x0 + w) * 4);
  }
  return { w, h, px };
};

const car = crop(carBox);

/** Перекраска: цвет берётся из маски, насыщенность сохраняется по каналу. */
function recolor(img, fn) {
  const out = Buffer.alloc(img.px.length);
  for (let i = 0; i < img.px.length; i += 4) {
    const [r, g, b, a] = [img.px[i], img.px[i + 1], img.px[i + 2], img.px[i + 3]];
    const [nr, ng, nb] = fn(r, g, b);
    out[i] = nr; out[i + 1] = ng; out[i + 2] = nb;
    // Шум ниже ALPHA_MIN гасим полностью: он даёт серую дымку вокруг контура.
    out[i + 3] = a < ALPHA_MIN ? 0 : a;
  }
  return { w: img.w, h: img.h, px: out };
}

// Цвета бренда из таблицы стилей эталонного сайта.
const ACCENT = '#0074BA';   // --accent
const GOLD = '#F4DD5B';     // --gold
const INK = '#0B0B0B';      // --bg-soft

// Машина: исходный синий → акцент бренда; светлый вариант → почти белый.
const carAccent = recolor(car, (r, g, b) => {
  const t = (r + g + b) / (3 * 255);
  return [Math.round(0x00 + t * 40), Math.round(0x74 + t * 30), Math.round(0xBA + t * 30)];
});
const carLight = recolor(car, (r, g, b) => {
  const t = (r + g + b) / (3 * 255);
  return [Math.round(236 + t * 19), Math.round(240 + t * 15), Math.round(247 + t * 8)];
});

writeFileSync('brand/logo-mark-car-accent.png', encode(carAccent.w, carAccent.h, carAccent.px));
writeFileSync('brand/logo-mark-car-light.png', encode(carLight.w, carLight.h, carLight.px));
console.log(`знак машины: ${car.w}×${car.h} (2 варианта)`);

// ── Полный логотип (машина + надписи) ──────────────────────────────────────
const full = crop({ x0: Math.min(carBox.x0, textBox.x0), x1: Math.max(carBox.x1, textBox.x1),
                    y0: carBox.y0, y1: textBox.y1 });
writeFileSync('brand/logo-lockup-source.png', encode(full.w, full.h, full.px));
console.log(`полный логотип: ${full.w}×${full.h}`);

// Для тёмного фона: белое остаётся белым, синее становится светлее.
const lockupDark = recolor(full, (r, g, b) => {
  const blue = b > r + 20 && b > 120;
  if (!blue) return [r, g, b];
  const t = (r + g + b) / (3 * 255);
  return [Math.round(200 + t * 55), Math.round(220 + t * 30), Math.round(240 + t * 15)];
});
writeFileSync('brand/logo-lockup-dark.png', encode(lockupDark.w, lockupDark.h, lockupDark.px));
console.log('полный логотип для тёмного фона готов');
