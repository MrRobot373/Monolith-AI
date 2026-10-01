import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32, PARAMS);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, salt, key] = stored.split("$");
  if (alg !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length, PARAMS);
  return timingSafeEqual(actual, expected);
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** AES-256-GCM with a key derived from the server secret. */
export function secretBox(secret: string) {
  const key = createHash("sha256").update(`aatmiq-license:${secret}`).digest();
  return {
    seal(plain: string) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
    },
    open(sealed: string) {
      const [iv, tag, enc] = sealed.split(".").map((p) => Buffer.from(p, "base64"));
      const d = createDecipheriv("aes-256-gcm", key, iv!);
      d.setAuthTag(tag!);
      return Buffer.concat([d.update(enc!), d.final()]).toString("utf8");
    },
  };
}
