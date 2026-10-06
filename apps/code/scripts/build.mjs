#!/usr/bin/env node
/**
 * Builds the Aatmiq Code distribution into apps/code/dist/aatmiq-code:
 *   1. the pinned upstream Code-OSS server build (base.json), checked against its sha256
 *   2. our product.json overrides (name, data folders, Open VSX, self-hosted webviews, no telemetry)
 *   3. branding (icons, page title) and machine-level default settings
 *   4. built-in extensions from ./extensions (theme, Aatmiq panel)
 *
 * Usage: node scripts/build.mjs [--out <dir>] [--arch x64|arm64]
 * The download is cached in apps/code/.cache. Set AATMIQ_CODE_BASE_TARBALL to use a local file.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const arch = opt("arch", process.arch === "arm64" ? "arm64" : "x64");
const out = resolve(opt("out", join(ROOT, "dist", "aatmiq-code")));
const base = JSON.parse(readFileSync(join(ROOT, "base.json"), "utf8"));
const log = (m) => console.log(`[aatmiq-code] ${m}`);

/** Merge `over` into `target`; null removes a key. Objects merge, everything else replaces. */
export function mergeProduct(target, over) {
  for (const [k, v] of Object.entries(over)) {
    if (k === "//") continue;
    if (v === null) delete target[k];
    else if (v && typeof v === "object" && !Array.isArray(v) && target[k] && typeof target[k] === "object" && !Array.isArray(target[k])) mergeProduct(target[k], v);
    else target[k] = v;
  }
  return target;
}

async function fetchBase() {
  if (process.env.AATMIQ_CODE_BASE_TARBALL) return process.env.AATMIQ_CODE_BASE_TARBALL;
  const url = base.url.replaceAll("{version}", base.version).replaceAll("{arch}", arch);
  const cache = join(ROOT, ".cache");
  mkdirSync(cache, { recursive: true });
  const file = join(cache, url.split("/").pop());
  if (!existsSync(file)) {
    log(`downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
    const tmp = `${file}.part`;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    renameSync(tmp, file);
  }
  return file;
}

function verify(file) {
  const want = base.sha256?.[arch];
  const got = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (!want) log(`warning: no pinned sha256 for ${arch} (got ${got})`);
  else if (want !== got) throw new Error(`checksum mismatch for ${file}: expected ${want}, got ${got}`);
}

/**
 * Release builds inline product.json into their bundles as an object literal
 * (`…={nameShort:"…",…}`). Replace each with ours (JSON is a valid object literal).
 */
export function replaceInlinedProduct(code, product) {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = code.indexOf("{nameShort:", from);
    if (at < 0) break;
    let depth = 0;
    let quote = null;
    let end = -1;
    for (let i = at; i < code.length; i++) {
      const c = code[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error("unbalanced product literal");
    const json = JSON.stringify(product);
    code = code.slice(0, at) + json + code.slice(end + 1);
    from = at + json.length;
    count++;
  }
  return { code, count };
}

/** Add `configurationDefaults` to the web workbench options the server sends to the browser. */
export function injectConfigurationDefaults(code, defaults) {
  const anchor = /productConfiguration:([A-Za-z_$][\w$]*),callbackRoute:([A-Za-z_$][\w$]*)\}/;
  if (!anchor.test(code)) throw new Error("workbench options not found in server-main.js; the upstream build layout changed");
  return code.replace(anchor, (m, a, b) => `productConfiguration:${a},callbackRoute:${b},configurationDefaults:${JSON.stringify(defaults)}}`);
}

async function icons(dir) {
  let canvas;
  try {
    canvas = await import("@napi-rs/canvas");
  } catch {
    log("warning: @napi-rs/canvas not installed; keeping upstream icons");
    return;
  }
  const svg = readFileSync(join(ROOT, "branding", "icon.svg"));
  const img = await canvas.loadImage(svg);
  const png = (size) => {
    const c = canvas.createCanvas(size, size);
    c.getContext("2d").drawImage(img, 0, 0, size, size);
    return c.toBuffer("image/png");
  };
  writeFileSync(join(dir, "code-192.png"), png(192));
  writeFileSync(join(dir, "code-512.png"), png(512));
  // An .ico holding one 48px PNG (supported by every current browser).
  const p = png(48);
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head.writeUInt8(48, 6);
  head.writeUInt8(48, 7);
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(p.length, 14);
  head.writeUInt32LE(22, 18);
  writeFileSync(join(dir, "favicon.ico"), Buffer.concat([head, p]));
}

async function main() {
  const tarball = await fetchBase();
  verify(tarball);
  const work = mkdtempSync(join(tmpdir(), "aatmiq-code-"));
  execFileSync("tar", ["xzf", tarball, "-C", work]);
  const [top] = readdirSync(work);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(dirname(out), { recursive: true });
  cpSync(join(work, top), out, { recursive: true, verbatimSymlinks: true });
  rmSync(work, { recursive: true, force: true });

  // Product.
  const productPath = join(out, "product.json");
  const product = mergeProduct(JSON.parse(readFileSync(productPath, "utf8")), JSON.parse(readFileSync(join(ROOT, "product.json"), "utf8")));
  writeFileSync(productPath, JSON.stringify(product, null, "\t"));
  let inlined = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) {
        const src = readFileSync(p, "utf8");
        if (!src.includes("{nameShort:")) continue;
        const r = replaceInlinedProduct(src, product);
        writeFileSync(p, r.code);
        inlined += r.count;
      }
    }
  };
  walk(join(out, "out"));
  if (inlined === 0) throw new Error("no inlined product configuration found; the upstream build layout changed");
  log(`product configuration replaced in ${inlined} places`);

  // Branding.
  const resources = join(out, "resources", "server");
  await icons(resources);
  const manifestPath = join(resources, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, name: product.nameLong, short_name: product.nameShort }, null, 2));
  for (const v of ["dark", "light", "hcDark", "hcLight"]) {
    cpSync(join(ROOT, "branding", `letterpress-${v}.svg`), join(out, "out", "media", `letterpress-${v}.svg`));
  }
  const html = join(out, "out", "vs", "code", "browser", "workbench", "workbench.html");
  writeFileSync(html, readFileSync(html, "utf8").replace('apple-mobile-web-app-title" content="Code"', `apple-mobile-web-app-title" content="${product.nameShort}"`));

  // Built-in extensions and defaults.
  for (const name of readdirSync(join(ROOT, "extensions"))) {
    cpSync(join(ROOT, "extensions", name), join(out, "extensions", name), { recursive: true });
  }
  // Defaults go into the workbench's own options (configurationDefaults), which apply before any
  // extension loads (theme, startup editor) and which people can still override.
  const defaults = JSON.parse(readFileSync(join(ROOT, "settings.json"), "utf8"));
  delete defaults["//"];
  const serverMain = join(out, "out", "server-main.js");
  const patched = injectConfigurationDefaults(readFileSync(serverMain, "utf8"), defaults);
  writeFileSync(serverMain, patched);
  mkdirSync(join(out, "aatmiq"), { recursive: true });
  writeFileSync(join(out, "aatmiq", "build.json"), JSON.stringify({ base: base.name, version: base.version, arch, builtAt: new Date().toISOString() }, null, 2));
  log(`built ${product.nameLong} on ${base.name} ${base.version} (${arch}) → ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`[aatmiq-code] ${e.message}`);
    process.exit(1);
  });
}
