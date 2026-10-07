// RFC 6238 codes for tests (what an authenticator app shows).
import { createHmac } from "node:crypto";

function base32(s) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

/** The current 6-digit code for an otpauth:// URI (or a base32 secret). */
export function totpCode(uriOrSecret, at = Date.now()) {
  const secret = uriOrSecret.startsWith("otpauth:") ? new URL(uriOrSecret).searchParams.get("secret") : uriOrSecret;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac("sha1", base32(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
