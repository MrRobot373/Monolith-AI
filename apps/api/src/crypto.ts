import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** AES-256-GCM encryption for stored secrets (provider API keys, connector tokens). */
export function createSecretBox(secret: string) {
  const key = createHash("sha256").update(`aatmiq:secretbox:${secret}`).digest();
  return {
    encrypt(plain: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
    },
    decrypt(token: string): string {
      const [v, iv, tag, data] = token.split(".");
      if (v !== "v1" || !iv || !tag || !data) throw new Error("Invalid secret format");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    },
  };
}
export type SecretBox = ReturnType<typeof createSecretBox>;

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
