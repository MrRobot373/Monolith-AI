/**
 * What the desktop app's windows may do, kept free of Electron so it can be tested on its own.
 *
 * Windows show the organization's Aatmiq server and nothing else: its own pages, its IDE host
 * (IDE_URL) and, during single sign-on, the identity providers it uses. Links from Aatmiq to
 * anywhere else open in the person's browser. Remote pages never get Node or any app API.
 */

/** What the server says about itself at /api/public/desktop. */
export interface ServerInfo {
  product: "aatmiq";
  /** The organization's product name (branding), for window titles. */
  name: string;
  /** Where Aatmiq's pages live (APP_URL's origin). */
  appOrigin: string;
  /** Aatmiq Code's own host, when IDE_URL is set. */
  ideOrigin: string | null;
  /** Identity providers the sign-in page sends people to (Google, Microsoft, OpenID Connect). */
  signInOrigins: string[];
}

export interface Origins {
  /** Aatmiq itself: its pages and its IDE host. */
  app: string[];
  /** Sign-in providers. */
  signIn: string[];
}

export const originsOf = (info: ServerInfo): Origins => ({
  app: [info.appOrigin, ...(info.ideOrigin ? [info.ideOrigin] : [])],
  signIn: info.signInOrigins,
});

/**
 * The server address someone typed, as an origin: https assumed, paths dropped. Plain http only
 * for this machine or a private network name/address (a TLS reverse proxy belongs in front of
 * anything else). Throws a readable error.
 */
export function normalizeServer(input: string): string {
  let raw = input.trim();
  if (!raw) throw new Error("Enter your organization's Aatmiq address.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("That doesn't look like a web address.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Use an https:// address.");
  if (u.username || u.password) throw new Error("Leave the user name and password out of the address.");
  if (u.protocol === "http:" && !isLocalHost(u.hostname)) throw new Error("Use https:// (plain http is only for this computer or a local test server).");
  return u.origin;
}

/** localhost, loopback, private IPv4 ranges, and single-label or .local/.internal/.lan names. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/\.(local|internal|lan|home\.arpa)$/.test(h)) return true;
  return !h.includes(".") && !h.includes(":");
}

/** Checks the answer from /api/public/desktop and that it describes the server that was asked. */
export function parseServerInfo(server: string, body: unknown): ServerInfo {
  const b = body as Partial<ServerInfo> | null;
  if (!b || b.product !== "aatmiq" || typeof b.appOrigin !== "string") throw new Error("That address isn't an Aatmiq server (or it's an older version without desktop support).");
  const origin = (s: unknown) => {
    try {
      const u = new URL(String(s));
      return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
    } catch {
      return null;
    }
  };
  const appOrigin = origin(b.appOrigin);
  if (!appOrigin) throw new Error("The server sent an address the app can't use.");
  return {
    product: "aatmiq",
    name: typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 60) : "Aatmiq",
    // People may reach the server at another name than APP_URL (an internal alias); both are Aatmiq.
    appOrigin: appOrigin === server ? server : appOrigin,
    ideOrigin: b.ideOrigin ? origin(b.ideOrigin) : null,
    // https, or plain http on this machine or a private network (a test identity provider).
    signInOrigins: Array.isArray(b.signInOrigins)
      ? b.signInOrigins.map(origin).filter((o): o is string => !!o && (o.startsWith("https:") || isLocalHost(new URL(o).hostname)))
      : [],
  };
}

export type Decision = "allow" | "external" | "block";

const originOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
};

/**
 * Where a window may go. `from` is the page it's on (empty for a new window's first load).
 *  - Aatmiq and its sign-in providers: in the app.
 *  - Elsewhere, from an Aatmiq page (or a new window): the person's browser (http, https, mailto).
 *  - Elsewhere over https, from a page that isn't Aatmiq's: in the app. A window only gets off
 *    Aatmiq through a sign-in provider, and providers hand over to each other on the way back
 *    (Microsoft to a company's own login page, Google to its account chooser).
 *  - Anything else (file:, javascript:, custom schemes): nowhere.
 */
export function decideNavigation(from: string, to: string, o: Origins): Decision {
  if (/^mailto:/i.test(to)) return "external";
  const target = originOf(to);
  if (!target) return "block";
  if (o.app.includes(target) || o.signIn.includes(target)) return "allow";
  const current = originOf(from);
  if (current && !o.app.includes(current) && target.startsWith("https:")) return "allow";
  return "external";
}

/**
 * A window an Aatmiq page opens. Besides decideNavigation's rules, an Aatmiq page may open a blank
 * window and point it somewhere once it knows where (the Code page does this for a fresh IDE link,
 * so the window isn't blocked as a pop-up); that later navigation is checked like any other.
 */
export function decideWindowOpen(from: string, to: string, o: Origins): Decision {
  const current = originOf(from);
  if (to === "about:blank" || to === "") return current && o.app.includes(current) ? "allow" : "block";
  return decideNavigation(from, to, o);
}

/** Browser permissions remote pages may have: clipboard for the IDE, notifications, full screen. */
const GRANTED = new Set(["clipboard-read", "clipboard-sanitized-write", "notifications", "fullscreen", "window-management"]);

export function permissionAllowed(permission: string, requestingUrl: string, o: Origins): boolean {
  const origin = originOf(requestingUrl);
  return !!origin && o.app.includes(origin) && GRANTED.has(permission);
}

/**
 * A link like aatmiq://open?server=https://aatmiq.acme.com&path=/app/code/abc, from the web app's
 * "Open in desktop app". Only a path on the same server is taken; another server just pre-fills
 * the connect screen (the app never switches servers on its own).
 */
export function parseDeepLink(link: string, current: string | null): { kind: "open"; url: string } | { kind: "connect"; server: string } | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol !== "aatmiq:") return null;
  const server = (() => {
    try {
      return normalizeServer(u.searchParams.get("server") ?? "");
    } catch {
      return null;
    }
  })();
  const path = u.searchParams.get("path") ?? "/app/code";
  const safePath = /^\/(?!\/)[\w\-./?=&%~]*$/.test(path) ? path : "/app/code";
  if (!server) return null;
  if (current && server === current) return { kind: "open", url: `${current}${safePath}` };
  return { kind: "connect", server };
}
