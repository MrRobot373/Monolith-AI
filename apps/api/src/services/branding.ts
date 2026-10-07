/**
 * The organization's logo: checked on upload (real image bytes, no scripts in SVG), kept in
 * storage, and served from a public URL so the sign-in page can show it.
 */
import { randomBytes } from "node:crypto";

export const MAX_LOGO_BYTES = 512 * 1024;

export const LOGO_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
} as const;
export type LogoType = keyof typeof LOGO_TYPES;

/** The media type from the file's first bytes (never from its name or the browser's claim). */
export function sniffLogo(data: Buffer): LogoType | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  const head = data.subarray(0, 1024).toString("utf8").replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

/**
 * SVG can carry scripts, event handlers and embedded HTML. Browsers don't run them in an <img>,
 * but someone could open the logo URL directly, so files with any of these are refused (and the
 * URL is served with a sandboxing Content-Security-Policy as well).
 */
export function svgProblem(data: Buffer): string | null {
  const s = data.toString("utf8");
  if (/<script[\s>]/i.test(s)) return "it contains a script";
  if (/<foreignObject[\s>]/i.test(s)) return "it embeds HTML (foreignObject)";
  if (/\son[a-z]+\s*=/i.test(s)) return "it contains event handlers (on…= attributes)";
  if (/(javascript|vbscript)\s*:/i.test(s)) return "it contains a script link";
  if (/<!ENTITY/i.test(s)) return "it declares XML entities";
  if (/(?:xlink:)?href\s*=\s*["']\s*(?:https?:|\/\/)/i.test(s)) return "it loads files from other sites";
  return null;
}

export const newLogoVersion = () => randomBytes(6).toString("hex");

export const logoUrl = (logo: { version: string } | null | undefined) => (logo ? `/api/public/logo?v=${logo.version}` : null);

/** Headers for the public logo: a cached image that can't run anything if opened directly. */
export function logoHeaders(type: string, current: boolean): Record<string, string> {
  return {
    "content-type": type,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "cross-origin-resource-policy": "same-site",
    // A URL with the current version never changes; anything else is checked again soon.
    "cache-control": current ? "public, max-age=31536000, immutable" : "public, max-age=300",
  };
}
