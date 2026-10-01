import { generateSigningKeys, importPrivateKey, importPublicKey, normalizePem } from "@aatmiq/license";
import { createPublicKey } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Config } from "./config";
import { secretBox, sha256 } from "./crypto";
import { signingKey, type LDB } from "./db";

export interface SigningKeys {
  kid: string;
  privateKey: Awaited<ReturnType<typeof importPrivateKey>>;
  publicPem: string;
  /** Every key we ever signed with, to verify keys presented at check-in. */
  publicKeys: Map<string, Awaited<ReturnType<typeof importPublicKey>>>;
}

/** Load the active signing key (from SERVER env, or the database), creating one on first start. */
export async function loadSigningKeys(db: LDB, cfg: Config): Promise<SigningKeys> {
  const box = secretBox(cfg.secret);
  if (cfg.signingKeyPem) {
    const privatePem = normalizePem(cfg.signingKeyPem, "PRIVATE KEY");
    const publicPem = createPublicKey(privatePem).export({ type: "spki", format: "pem" }).toString();
    const kid = sha256(publicPem).slice(0, 16);
    await db
      .insert(signingKey)
      .values({ kid, privateKeyEnc: box.seal(privatePem), publicPem, active: true })
      .onConflictDoNothing();
  } else {
    const [existing] = await db.select().from(signingKey).where(eq(signingKey.active, true)).limit(1);
    if (!existing) {
      const k = await generateSigningKeys();
      const kid = sha256(k.publicPem).slice(0, 16);
      await db.insert(signingKey).values({ kid, privateKeyEnc: box.seal(k.privatePem), publicPem: k.publicPem, active: true });
    }
  }
  const all = await db.select().from(signingKey).orderBy(desc(signingKey.createdAt));
  const active = cfg.signingKeyPem
    ? all.find((k) => k.kid === sha256(createPublicKey(normalizePem(cfg.signingKeyPem!, "PRIVATE KEY")).export({ type: "spki", format: "pem" }).toString()).slice(0, 16))!
    : all.find((k) => k.active)!;
  const publicKeys = new Map<string, Awaited<ReturnType<typeof importPublicKey>>>();
  for (const k of all) publicKeys.set(k.kid, await importPublicKey(k.publicPem));
  return { kid: active.kid, privateKey: await importPrivateKey(box.open(active.privateKeyEnc)), publicPem: active.publicPem, publicKeys };
}
