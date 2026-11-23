/**
 * Generates the extension icons as PNGs.
 *
 * The shapes are simple signed-distance functions rendered with supersampling,
 * so we do not need any image dependency. Run through `build.ts`.
 */

import { deflateSync } from "node:zlib";
import { crc32 } from "./crc32";

type RGBA = [number, number, number, number];

const VIOLET: RGBA = [124, 92, 255, 255];
const TEAL: RGBA = [33, 199, 180, 255];
const WHITE: RGBA = [248, 250, 252, 255];

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);

  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const compressed = new Uint8Array(deflateSync(raw));

  return concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function mix(a: RGBA, b: RGBA, t: number): RGBA {
  const k = clamp01(t);
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
    Math.round(a[3] + (b[3] - a[3]) * k),
  ];
}

function inRoundedRect(
  x: number,
  y: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
): boolean {
  const halfWidth = (x1 - x0) / 2;
  const halfHeight = (y1 - y0) / 2;
  const centerX = x0 + halfWidth;
  const centerY = y0 + halfHeight;
  const dx = Math.abs(x - centerX) - (halfWidth - radius);
  const dy = Math.abs(y - centerY) - (halfHeight - radius);
  if (dx <= 0 && dy <= 0) return true;
  const outsideX = Math.max(dx, 0);
  const outsideY = Math.max(dy, 0);
  return outsideX * outsideX + outsideY * outsideY <= radius * radius;
}

function inCircle(x: number, y: number, centerX: number, centerY: number, radius: number): boolean {
  const dx = x - centerX;
  const dy = y - centerY;
  return dx * dx + dy * dy <= radius * radius;
}

/** A four-pointed star (astroid), used as the "agent" spark. */
function inSpark(x: number, y: number, centerX: number, centerY: number, radius: number): boolean {
  const dx = Math.abs(x - centerX) / radius;
  const dy = Math.abs(y - centerY) / radius;
  return Math.sqrt(dx) + Math.sqrt(dy) <= 1;
}

function sample(u: number, v: number): RGBA {
  let color: RGBA = [0, 0, 0, 0];

  if (inRoundedRect(u, v, 0.015, 0.015, 0.985, 0.985, 0.24)) {
    color = mix(VIOLET, TEAL, (u * 0.55 + v * 0.45 - 0.15) / 0.7);
  }

  // Browser window.
  if (inRoundedRect(u, v, 0.165, 0.185, 0.835, 0.615, 0.058)) {
    color = WHITE;
  }

  // Window chrome dots.
  for (const dotX of [0.225, 0.268, 0.311]) {
    if (inCircle(u, v, dotX, 0.237, 0.0165)) color = VIOLET;
  }

  // Content lines.
  if (inRoundedRect(u, v, 0.225, 0.325, 0.705, 0.362, 0.018)) color = [214, 210, 252, 255];
  if (inRoundedRect(u, v, 0.225, 0.402, 0.585, 0.439, 0.018)) color = [214, 210, 252, 255];

  // Sparks.
  if (inSpark(u, v, 0.495, 0.79, 0.155)) color = WHITE;
  if (inSpark(u, v, 0.755, 0.725, 0.066)) color = WHITE;

  return color;
}

export function renderIconPng(size: number): Uint8Array {
  const supersample = 3;
  const samples = supersample * supersample;
  const rgba = new Uint8Array(size * size * 4);

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < supersample; sy += 1) {
        for (let sx = 0; sx < supersample; sx += 1) {
          const u = (px + (sx + 0.5) / supersample) / size;
          const v = (py + (sy + 0.5) / supersample) / size;
          const [sr, sg, sb, sa] = sample(u, v);
          const alpha = sa / 255;
          r += sr * alpha;
          g += sg * alpha;
          b += sb * alpha;
          a += sa;
        }
      }

      const alpha = a / samples;
      const index = (py * size + px) * 4;
      rgba[index] = alpha === 0 ? 0 : Math.round(r / (a / 255));
      rgba[index + 1] = alpha === 0 ? 0 : Math.round(g / (a / 255));
      rgba[index + 2] = alpha === 0 ? 0 : Math.round(b / (a / 255));
      rgba[index + 3] = Math.round(alpha);
    }
  }

  return encodePng(size, size, rgba);
}
