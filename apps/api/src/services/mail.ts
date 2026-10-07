/**
 * Outgoing email (SMTP) for invitations and password resets. The server comes from SMTP_URL in the
 * environment when set, otherwise from Admin → Settings → Email. Without either, nothing is sent and
 * people share links by hand (invitations) or ask an admin (password resets).
 */
import { organization, type DB, type EmailSettingsStored } from "@aatmiq/db";
import { DEFAULT_ACCENT, PRODUCT_NAME } from "@aatmiq/shared";
import nodemailer, { type Transporter } from "nodemailer";
import type { Config } from "../config";
import type { Storage } from "./storage";
import type { SecretBox } from "../crypto";

export interface MailServer {
  host: string;
  port: number;
  security: "tls" | "starttls" | "none";
  username: string | null;
  password: string | null;
  from: string;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  /** Short paragraphs; the first is the greeting or summary. */
  lines: string[];
  button?: { label: string; url: string };
  /** Small print under the button, e.g. when a link expires. */
  note?: string;
}

/** Parses SMTP_URL: smtp://user:pass@host:587 (STARTTLS when offered), smtps://…:465 (TLS). */
export function serverFromUrl(url: string, from: string | undefined): MailServer {
  const u = new URL(url);
  if (u.protocol !== "smtp:" && u.protocol !== "smtps:") throw new Error("SMTP_URL must start with smtp:// or smtps://");
  const tls = u.protocol === "smtps:";
  return {
    host: u.hostname,
    port: Number(u.port || (tls ? 465 : 587)),
    security: tls ? "tls" : u.searchParams.get("starttls") === "never" ? "none" : "starttls",
    username: u.username ? decodeURIComponent(u.username) : null,
    password: u.password ? decodeURIComponent(u.password) : null,
    from: from || (u.username ? decodeURIComponent(u.username) : `no-reply@${u.hostname}`),
  };
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Inline image id for the organization's logo in emails. */
const LOGO_CID = "org-logo@aatmiq";

/** Plain, readable HTML that works in every mail client (tables, inline styles; the logo is an inline attachment). */
export function renderMail(m: OutgoingMail, brand: { productName: string; accent: string; logo?: { type: string; data: Buffer } | null }) {
  const p = (s: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#1f2328">${escape(s)}</p>`;
  const button = m.button
    ? `<p style="margin:22px 0"><a href="${escape(m.button.url)}" style="display:inline-block;background:#111418;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 18px;border-radius:8px">${escape(m.button.label)}</a></p>
<p style="margin:0 0 14px;font-size:12.5px;line-height:1.5;color:#5b636e">Or paste this link into your browser:<br><span style="word-break:break-all;color:#1f2328">${escape(m.button.url)}</span></p>`
    : "";
  const note = m.note ? `<p style="margin:14px 0 0;font-size:12.5px;line-height:1.5;color:#5b636e">${escape(m.note)}</p>` : "";
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e3e6ea;border-radius:12px">
<tr><td style="padding:22px 28px 6px;font-size:14px;font-weight:600;color:#1f2328">${
    brand.logo
      ? `<img src="cid:${LOGO_CID}" alt="" height="24" style="height:24px;width:auto;vertical-align:middle;margin-right:8px;border:0">`
      : `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${escape(brand.accent)};margin-right:8px"></span>`
  }${escape(brand.productName)}</td></tr>
<tr><td style="padding:12px 28px 26px">${m.lines.map(p).join("")}${button}${note}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [...m.lines, ...(m.button ? [`${m.button.label}: ${m.button.url}`] : []), ...(m.note ? [m.note] : [])].join("\n\n");
  return { html, text };
}

export function createMailer(opts: { db: DB; cfg: Config; box: SecretBox; storage?: Storage }) {
  const { db, cfg, box, storage } = opts;
  let cached: { key: string; t: Transporter } | null = null;

  async function org() {
    return (await db.select().from(organization).limit(1))[0] ?? null;
  }

  /** The mail server in use, or null when email is off. */
  async function server(): Promise<(MailServer & { source: "env" | "settings" }) | null> {
    if (cfg.smtpUrl) return { ...serverFromUrl(cfg.smtpUrl, cfg.mailFrom ?? undefined), source: "env" };
    const s = (await org())?.emailSettings;
    if (!s?.host) return null;
    return { ...fromStored(s), source: "settings" };
  }

  function fromStored(s: EmailSettingsStored): MailServer {
    return {
      host: s.host,
      port: s.port,
      security: s.security,
      username: s.username,
      password: s.passwordEnc ? box.decrypt(s.passwordEnc) : null,
      from: s.from,
    };
  }

  function transporter(s: MailServer): Transporter {
    const key = JSON.stringify(s);
    if (cached?.key === key) return cached.t;
    cached?.t.close();
    const t = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.security === "tls",
      ignoreTLS: s.security === "none",
      requireTLS: s.security === "starttls",
      auth: s.username ? { user: s.username, pass: s.password ?? "" } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
    cached = { key, t };
    return t;
  }

  async function brand() {
    const o = await org();
    return { productName: o?.productName ?? PRODUCT_NAME, accent: o?.accentColor ?? DEFAULT_ACCENT };
  }

  /** The uploaded logo for the email header. SVG is left out: most mail clients don't show it. */
  async function emailLogo() {
    const logo = (await org())?.logo;
    if (!logo || !storage || logo.type === "image/svg+xml") return null;
    return { type: logo.type, data: await storage.get(logo.key) };
  }

  async function deliver(s: MailServer, m: OutgoingMail) {
    const logo = await emailLogo().catch(() => null);
    const { html, text } = renderMail(m, { ...(await brand()), logo });
    await transporter(s).sendMail({
      from: s.from,
      to: m.to,
      subject: m.subject,
      text,
      html,
      attachments: logo ? [{ filename: `logo.${logo.type.split("/")[1]}`, content: logo.data, contentType: logo.type, cid: LOGO_CID }] : undefined,
    });
  }

  return {
    server,
    async configured() {
      return (await server()) !== null;
    },
    /** Sends when email is set up. Returns false (and sends nothing) when it isn't. */
    async send(m: OutgoingMail): Promise<boolean> {
      const s = await server();
      if (!s) return false;
      await deliver(s, m);
      return true;
    },
    /** Sends through a server that isn't saved yet (Admin → Settings → Email → Send test). */
    async sendWith(s: MailServer, m: OutgoingMail) {
      await deliver(s, m);
    },
    brand,
    fromStored,
  };
}

export type Mailer = ReturnType<typeof createMailer>;
