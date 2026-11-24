#!/usr/bin/env node
// Validates the chart series colours against the actual surfaces (non-text
// graphics require >= 3:1 under WCAG 1.4.11). Exits non-zero on any failure.

const pairs = [
  { name: "浅色 请求线 #2563eb / 表面 #ffffff", fg: "#2563eb", bg: "#ffffff" },
  { name: "浅色 图片线 #15803d / 表面 #ffffff", fg: "#15803d", bg: "#ffffff" },
  { name: "深色 请求线 #2563eb / 表面 #0f172a", fg: "#2563eb", bg: "#0f172a" },
  { name: "深色 图片线 #4ade80 / 表面 #0f172a", fg: "#4ade80", bg: "#0f172a" },
];

const MIN_GRAPHIC = 3;

function channel(value) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

let failed = false;
for (const pair of pairs) {
  const ratio = contrast(pair.fg, pair.bg);
  const pass = ratio >= MIN_GRAPHIC;
  failed ||= !pass;
  console.log(`${pass ? "PASS" : "FAIL"} ${pair.name}: ${ratio.toFixed(2)} (>= ${MIN_GRAPHIC})`);
}
process.exit(failed ? 1 : 0);
