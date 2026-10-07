/**
 * The Work AI browser: one headless Chromium per task, run by the API and driven by the agent's
 * browser_* tools (through the internal API, with the task's token). It runs as the task's own
 * Unix user when tasks are isolated, keeps its profile in the task's runtime folder, saves
 * screenshots and downloads into the task folder, and reaches the web only through the egress
 * proxy (no private or internal addresses unless an admin allows them).
 *
 * Pages come back as text with numbered elements ("[4] button "Sign in""), which the agent uses
 * to click or type. A click or Enter that would submit a form is held until the agent repeats it
 * with confirm_submit, which the approval policy turns into a question for the person.
 */
import { chown, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import type { EgressProxy } from "./egress";

export const MAX_TEXT = 12_000;
const NAV_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 10_000;

export class BrowserError extends Error {}

/** Where the browser lives for one task. */
export interface BrowserTarget {
  /** The task folder: screenshots and downloads go here. */
  workdir: string;
  /** Private folder for the browser profile (cookies, cache). */
  profileDir: string;
  /** Run as this Unix user (tasks isolated); undefined: as the API's user. */
  uid?: number;
}

export interface PageView {
  url: string;
  title: string;
  /** Page text with numbered elements, cut to MAX_TEXT. */
  text: string;
  truncated: boolean;
  /** Files the page downloaded since the last action, relative to the task folder. */
  downloads: string[];
}

/** Find the system's Chromium: BROWSER_PATH, the image's /usr/bin/chromium, or Playwright's own copy. */
export function findChromium(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const p of [env.BROWSER_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser"])
    if (p && existsSync(p)) return p;
  try {
    const p = chromium.executablePath();
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * Runs in the page (plain JavaScript, so no build step rewrites it): numbers the visible elements
 * a person could use and returns the page as text, each element where it appears:
 * [n] role "name" (value).
 */
export const SNAPSHOT = String.raw`(() => {
  const doc = document;
  doc.querySelectorAll("[data-aatmiq-ref]").forEach((el) => el.removeAttribute("data-aatmiq-ref"));
  const interactive = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [contenteditable=""], [contenteditable="true"]';
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
  const label = (e) => {
    const by = e.getAttribute("aria-labelledby");
    const aria = e.getAttribute("aria-label") || (by && doc.getElementById(by) ? doc.getElementById(by).textContent : "");
    const byFor = e.id ? (doc.querySelector('label[for="' + CSS.escape(e.id) + '"]') || {}).textContent : "";
    const wrap = e.closest("label") ? e.closest("label").textContent : "";
    const own = e.tagName === "INPUT" ? e.placeholder || wrap || e.name : e.innerText || e.title || e.getAttribute("alt") || wrap;
    return clean(aria || byFor || own).slice(0, 100);
  };
  const role = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === "a") return "link";
    if (t === "select") return "select";
    if (t === "textarea") return "textbox";
    if (t === "summary") return "button";
    if (t === "input") {
      const type = el.type;
      if (["submit", "button", "reset", "image"].includes(type)) return "button";
      if (["checkbox", "radio"].includes(type)) return type;
      return "textbox";
    }
    if (el.hasAttribute("contenteditable")) return "textbox";
    return t;
  };
  let n = 0;
  const refs = new Map();
  for (const el of Array.from(doc.querySelectorAll(interactive))) {
    if (!visible(el) || el.disabled) continue;
    refs.set(el, ++n);
    el.setAttribute("data-aatmiq-ref", String(n));
  }
  const out = [];
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = clean(node.textContent);
      if (t && node.parentElement && visible(node.parentElement) && !node.parentElement.closest("[data-aatmiq-ref]")) out.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    const tag = el.tagName;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "svg", "SVG"].includes(tag)) return;
    const ref = refs.get(el);
    if (ref) {
      let value = "";
      if (tag === "SELECT") value = " (selected: " + ((el.selectedOptions[0] || {}).text || "") + "; options: " + Array.from(el.options).map((o) => o.text).slice(0, 15).join(" | ") + ")";
      else if (el.type === "checkbox" || el.type === "radio") value = el.checked ? " (checked)" : " (not checked)";
      else if ((tag === "INPUT" || tag === "TEXTAREA") && el.type !== "submit" && el.type !== "button") value = el.type === "password" ? (el.value ? " (filled)" : "") : el.value ? " (value: " + el.value.slice(0, 80) + ")" : "";
      const href = tag === "A" ? " → " + (el.getAttribute("href") || "").slice(0, 120) : "";
      out.push("[" + ref + "] " + role(el) + ' "' + label(el) + '"' + value + href);
      return;
    }
    if (/^H[1-6]$/.test(tag)) {
      const t = clean(el.innerText);
      if (t && visible(el)) out.push("#".repeat(Number(tag[1])) + " " + t);
      return;
    }
    el.childNodes.forEach(walk);
  };
  walk(doc.body || doc.documentElement);
  return out.join("\n");
})()`;

/** Runs in the page: would clicking (or pressing Enter in) this element submit a form? */
const SUBMITS = String.raw`(e, enter) => {
  const form = e.form || e.closest("form");
  if (!form) return false;
  if (enter) return e.tagName === "INPUT" && !["checkbox", "radio", "button", "file"].includes(e.type);
  if (e.tagName === "BUTTON") return (e.getAttribute("type") || "submit").toLowerCase() === "submit";
  return e.tagName === "INPUT" && (e.type === "submit" || e.type === "image");
}`;

/** Asks the page whether element [ref] submits a form (false when it can't tell). */
async function submits(page: Page, ref: number, enter: boolean): Promise<boolean> {
  const expr = `(${SUBMITS})(document.querySelector('[data-aatmiq-ref="${Number(ref)}"]'), ${enter ? "true" : "false"})`;
  return ((await page.evaluate(expr).catch(() => false)) as boolean) === true;
}

interface Session {
  context: BrowserContext;
  /** Short temp folder (Chromium's sockets live there; Unix socket paths max out at 108 bytes). */
  tmp: string;
  page: Page;
  target: BrowserTarget;
  egress: EgressProxy;
  downloads: string[];
  /** A page load the egress proxy refused (plain HTTP), reported with the next view. */
  blocked: { host: string; reason: string } | null;
  lastUsed: number;
}

export interface BrowserServiceOptions {
  executablePath: string | null;
  egress: () => Promise<EgressProxy>;
  /** Folder for the wrapper that starts Chromium as a task's user. */
  runtimeDir: string;
  idleMinutes?: number;
  log?: (msg: string, err?: unknown) => void;
}

export class BrowserService {
  /** Internal hosts the admin allows (Admin → Work AI); the egress proxy reads it on every request. */
  allowedHosts: string[] = [];
  private sessions = new Map<string, Session>();
  private starting = new Map<string, Promise<Session>>();
  private sweeper: NodeJS.Timeout;

  constructor(private opts: BrowserServiceOptions) {
    const idle = (opts.idleMinutes ?? 10) * 60_000;
    this.sweeper = setInterval(() => {
      for (const [id, s] of this.sessions) if (Date.now() - s.lastUsed > idle) void this.close(id);
    }, 60_000);
    this.sweeper.unref();
  }

  get available() {
    return !!this.opts.executablePath;
  }

  private async wrapper(): Promise<string> {
    const p = join(this.opts.runtimeDir, "aatmiq-chromium");
    await mkdir(this.opts.runtimeDir, { recursive: true });
    await writeFile(
      p,
      `#!/bin/sh\nexec setpriv --reuid="$AATMIQ_BROWSER_UID" --regid="$AATMIQ_BROWSER_UID" --clear-groups -- "$AATMIQ_BROWSER_BIN" "$@"\n`,
      { mode: 0o755 },
    );
    return p;
  }

  private async start(taskId: string, target: BrowserTarget): Promise<Session> {
    if (!this.opts.executablePath)
      throw new BrowserError("The browser isn't installed on this server. Ask your admin.");
    const egress = await this.opts.egress();
    const dirs = {
      data: join(target.profileDir, "data"),
      home: join(target.profileDir, "home"),
      cache: join(target.profileDir, "cache"),
      config: join(target.profileDir, "config"),
    };
    for (const d of Object.values(dirs)) await mkdir(d, { recursive: true, mode: 0o700 });
    // Chromium puts sockets in TMPDIR; a task folder's path is too long for them, so use /tmp.
    const tmp = await mkdtemp(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "aatmiq-br-"));
    if (target.uid !== undefined)
      for (const d of [target.profileDir, ...Object.values(dirs), tmp])
        await chown(d, target.uid, target.uid);
    const asUser = target.uid !== undefined && process.getuid?.() === 0;
    const context = await chromium
      .launchPersistentContext(dirs.data, {
        executablePath: asUser ? await this.wrapper() : this.opts.executablePath,
        headless: true,
        // Chromium's own sandbox needs user namespaces, which containers usually lack; the task's
        // own Unix user and the egress proxy are the boundary here.
        chromiumSandbox: false,
        proxy: { server: egress.url, bypass: "<-loopback>" },
        viewport: { width: 1280, height: 900 },
        acceptDownloads: true,
        locale: "en-US",
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: dirs.home,
          XDG_CACHE_HOME: dirs.cache,
          XDG_CONFIG_HOME: dirs.config,
          TMPDIR: tmp,
          ...(asUser
            ? {
                AATMIQ_BROWSER_UID: String(target.uid),
                AATMIQ_BROWSER_BIN: this.opts.executablePath,
              }
            : {}),
        },
        args: ["--disable-dev-shm-usage", "--no-first-run", "--disable-features=ServiceWorker"],
      })
      .catch(async (e: unknown) => {
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
        throw e;
      });
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    // Only web pages: no file://, chrome:// or other schemes, whatever a page links to.
    await context.route(/^(?!https?:|data:|blob:|about:)/i, (route) => route.abort("accessdenied"));
    const page = context.pages()[0] ?? (await context.newPage());
    const s: Session = {
      context,
      tmp,
      page,
      target,
      egress,
      downloads: [],
      blocked: null,
      lastUsed: Date.now(),
    };
    const watch = (p: Page) =>
      p.on("response", (r) => {
        const why = r.headers()["x-aatmiq-blocked"];
        if (why && r.request().isNavigationRequest())
          s.blocked = { host: new URL(r.url()).hostname, reason: decodeURIComponent(why) };
      });
    watch(page);
    context.on("page", watch);
    context.on("page", (p) => {
      // A link that opens a new tab: follow it in the same view.
      s.page = p;
    });
    context.on("close", () => this.sessions.delete(taskId));
    const onDownload = async (d: import("playwright-core").Download) => {
      try {
        const dir = join(target.workdir, "downloads");
        await mkdir(dir, { recursive: true });
        const file = join(
          dir,
          d
            .suggestedFilename()
            .replace(/[/\\\0]/g, "_")
            .slice(0, 120) || "download",
        );
        await d.saveAs(file);
        if (target.uid !== undefined)
          await chown(dir, target.uid, target.uid).then(() =>
            chown(file, target.uid!, target.uid!),
          );
        s.downloads.push(relative(target.workdir, file));
      } catch (e) {
        this.opts.log?.("browser: saving a download failed", e);
      }
    };
    context.on("page", (p) => p.on("download", (d) => void onDownload(d)));
    page.on("download", (d) => void onDownload(d));
    this.sessions.set(taskId, s);
    return s;
  }

  private async session(taskId: string, target: () => Promise<BrowserTarget>): Promise<Session> {
    const have = this.sessions.get(taskId);
    if (have) {
      have.lastUsed = Date.now();
      return have;
    }
    let p = this.starting.get(taskId);
    if (!p) {
      p = target().then((t) => this.start(taskId, t));
      this.starting.set(taskId, p);
      p.finally(() => this.starting.delete(taskId)).catch(() => undefined);
    }
    return p;
  }

  private refused(host: string, reason: string): never {
    throw new BrowserError(
      `The browser can't open ${host}: ${reason}. Pages on the organization's private network are off limits unless an admin allows them.`,
    );
  }

  private async view(s: Session): Promise<PageView> {
    await s.page.waitForLoadState("domcontentloaded").catch(() => undefined);
    if (s.blocked) {
      const b = s.blocked;
      s.blocked = null;
      this.refused(b.host, b.reason);
    }
    if (s.page.url().startsWith("chrome-error://")) {
      const last = s.egress.lastBlock();
      if (last && Date.now() - last.at < 15_000) this.refused(last.host, last.reason);
      throw new BrowserError("The page couldn't be loaded.");
    }
    // Give scripts a moment to render; never wait long for pages that keep connections open.
    await s.page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);
    const text = ((await s.page.evaluate(SNAPSHOT).catch(() => "")) as string) || "";
    const downloads = s.downloads.splice(0);
    return {
      url: s.page.url(),
      title: await s.page.title().catch(() => ""),
      text: text.slice(0, MAX_TEXT),
      truncated: text.length > MAX_TEXT,
      downloads,
    };
  }

  private async explain(e: unknown, url?: string): Promise<never> {
    const msg = e instanceof Error ? e.message : String(e);
    if (url) {
      const egress = await this.opts.egress();
      const host = (() => {
        try {
          return new URL(url).hostname;
        } catch {
          return "";
        }
      })();
      const why = host ? egress.recentBlock(host) : null;
      if (why) this.refused(host, why);
    }
    if (/ERR_NAME_NOT_RESOLVED/.test(msg))
      throw new BrowserError("That address couldn't be found.");
    if (/Timeout/i.test(msg)) throw new BrowserError("The page took too long to respond.");
    if (/ERR_ACCESS_DENIED|ERR_BLOCKED/.test(msg))
      throw new BrowserError("That address can't be opened in the browser.");
    throw new BrowserError(
      msg
        .split("\n")[0]!
        .replace(/^[a-zA-Z.]+: /, "")
        .slice(0, 300),
    );
  }

  private element(s: Session, ref: number) {
    if (!Number.isInteger(ref) || ref < 1)
      throw new BrowserError("Use an element number from the last page view, like 3.");
    return s.page.locator(`[data-aatmiq-ref="${ref}"]`).first();
  }

  private async exists(s: Session, ref: number) {
    const el = this.element(s, ref);
    if ((await el.count()) === 0)
      throw new BrowserError(
        `There's no element [${ref}] on the page any more. Look at the latest page view and use its numbers.`,
      );
    return el;
  }

  async open(taskId: string, target: () => Promise<BrowserTarget>, url: string): Promise<PageView> {
    let u: URL;
    try {
      u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
    } catch {
      throw new BrowserError("That isn't a web address.");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:")
      throw new BrowserError("Only http and https pages can be opened.");
    const s = await this.session(taskId, target);
    try {
      await s.page.goto(u.href, { waitUntil: "domcontentloaded" });
    } catch (e) {
      await this.explain(e, u.href);
    }
    return this.view(s);
  }

  async click(
    taskId: string,
    target: () => Promise<BrowserTarget>,
    ref: number,
    confirmSubmit: boolean,
  ): Promise<PageView> {
    const s = await this.session(taskId, target);
    const el = await this.exists(s, ref);
    if (!confirmSubmit && (await submits(s.page, ref, false)))
      throw new BrowserError(
        `[${ref}] submits a form. If that's what the task needs, call browser_click again with confirm_submit: true.`,
      );
    try {
      await el.click();
    } catch (e) {
      await this.explain(e, s.page.url());
    }
    return this.view(s);
  }

  async type(
    taskId: string,
    target: () => Promise<BrowserTarget>,
    ref: number,
    text: string,
    submit: boolean,
    confirmSubmit: boolean,
  ): Promise<PageView> {
    const s = await this.session(taskId, target);
    const el = await this.exists(s, ref);
    if (submit && !confirmSubmit && (await submits(s.page, ref, true)))
      throw new BrowserError(
        `Pressing Enter in [${ref}] submits a form. If that's what the task needs, call browser_type again with confirm_submit: true.`,
      );
    try {
      await el.fill(text);
      if (submit) await el.press("Enter");
    } catch (e) {
      await this.explain(e, s.page.url());
    }
    return this.view(s);
  }

  async select(
    taskId: string,
    target: () => Promise<BrowserTarget>,
    ref: number,
    option: string,
  ): Promise<PageView> {
    const s = await this.session(taskId, target);
    const el = await this.exists(s, ref);
    try {
      await el.selectOption({ label: option }).catch(() => el.selectOption(option));
    } catch (e) {
      await this.explain(e);
    }
    return this.view(s);
  }

  async back(taskId: string, target: () => Promise<BrowserTarget>): Promise<PageView> {
    const s = await this.session(taskId, target);
    await s.page.goBack().catch(() => undefined);
    return this.view(s);
  }

  /** The page's text from `offset` (for pages longer than one view). */
  async read(
    taskId: string,
    target: () => Promise<BrowserTarget>,
    offset: number,
  ): Promise<PageView & { offset: number; total: number }> {
    const s = await this.session(taskId, target);
    const v = await this.view(s);
    const full = ((await s.page.evaluate(SNAPSHOT).catch(() => "")) as string) || "";
    const start = Math.max(0, Math.min(offset, full.length));
    return {
      ...v,
      text: full.slice(start, start + MAX_TEXT),
      truncated: start + MAX_TEXT < full.length,
      offset: start,
      total: full.length,
    };
  }

  /** Saves a PNG in the task folder and returns its path relative to it. */
  async screenshot(
    taskId: string,
    target: () => Promise<BrowserTarget>,
    fullPage: boolean,
  ): Promise<{ file: string; url: string; title: string }> {
    const s = await this.session(taskId, target);
    const dir = join(s.target.workdir, "screenshots");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    await s.page.screenshot({ path: file, fullPage });
    if (s.target.uid !== undefined) {
      await chown(dir, s.target.uid, s.target.uid);
      await chown(file, s.target.uid, s.target.uid);
    }
    return {
      file: relative(s.target.workdir, file),
      url: s.page.url(),
      title: await s.page.title().catch(() => ""),
    };
  }

  async close(taskId: string) {
    const s = this.sessions.get(taskId);
    this.sessions.delete(taskId);
    await s?.context.close().catch(() => undefined);
    if (s) await rm(s.tmp, { recursive: true, force: true }).catch(() => undefined);
  }

  async closeAll() {
    clearInterval(this.sweeper);
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }
}
