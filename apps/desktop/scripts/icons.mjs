// Renders the app icon (build/icon.png, 1024px) from the Aatmiq Code icon. electron-builder makes
// the Windows .ico and macOS .icns from it. Uses @napi-rs/canvas from apps/code.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const root = new URL("..", import.meta.url).pathname;
const canvas = createRequire(`${root}../code/package.json`)("@napi-rs/canvas");
const size = 1024;
// Rasterise at full size (the SVG's own size is 32px).
const svg = readFileSync(`${root}../code/branding/icon.svg`, "utf8").replace("<svg ", `<svg width="${size}" height="${size}" `);
const img = await canvas.loadImage(Buffer.from(svg));
const c = canvas.createCanvas(size, size);
// macOS expects some margin around the rounded square.
const pad = Math.round(size * 0.1);
c.getContext("2d").drawImage(img, pad, pad, size - pad * 2, size - pad * 2);
writeFileSync(`${root}build/icon.png`, c.toBuffer("image/png"));
console.log("build/icon.png");
