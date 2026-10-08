/**
 * Aatmiq Code for the desktop (docs/07-code.md#desktop-app). A native window onto the
 * organization's Aatmiq server: people sign in as on the web (password, two-step, single sign-on),
 * and the IDE, terminals and the Aatmiq panel run on the server as before. What the app adds:
 * its own windows (so Ctrl/⌘+W, Ctrl+N and the rest reach the IDE instead of the browser), a dock
 * or taskbar entry, aatmiq:// links, and a remembered server and sign-in.
 *
 * Remote pages get no Node and no app API (sandboxed, context-isolated, no preload); only the
 * local connect screen has a two-function bridge. See policy.ts for where windows may go.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, net, session, shell, type MenuItemConstructorOptions, type Session, type WebContents } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decideNavigation, decideWindowOpen, normalizeServer, originsOf, parseDeepLink, parseServerInfo, permissionAllowed, type Origins, type ServerInfo } from "./policy";

const PARTITION = "persist:aatmiq";
const PROTOCOL = "aatmiq";
const START_PATH = "/app/code";
const STATIC = join(__dirname, "static");

// Tests (and people with several setups) can keep settings and sign-ins apart.
if (process.env.AATMIQ_DESKTOP_USER_DATA) app.setPath("userData", process.env.AATMIQ_DESKTOP_USER_DATA);

/* ───────────── Settings ───────────── */

interface Settings {
  server: string | null;
  info: ServerInfo | null;
  bounds?: { x: number; y: number; width: number; height: number };
  maximized?: boolean;
}
const settingsFile = () => join(app.getPath("userData"), "settings.json");
function loadSettings(): Settings {
  try {
    const s = JSON.parse(readFileSync(settingsFile(), "utf8")) as Settings;
    return { server: typeof s.server === "string" ? s.server : null, info: s.info ?? null, bounds: s.bounds, maximized: s.maximized };
  } catch {
    return { server: null, info: null };
  }
}
let settings: Settings = { server: null, info: null };
function saveSettings() {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
}

let origins: Origins = { app: [], signIn: [] };
const setInfo = (info: ServerInfo | null) => {
  origins = info ? originsOf(info) : { app: [], signIn: [] };
  if (info && settings.server && !origins.app.includes(settings.server)) origins.app.push(settings.server);
};

/** Ask a server whether it is Aatmiq, and where its windows may go. */
async function fetchInfo(server: string): Promise<ServerInfo> {
  let res: Response;
  try {
    res = await net.fetch(`${server}/api/public/desktop`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new Error(`Couldn't reach ${new URL(server).host}${e instanceof Error && e.message ? ` (${e.message.replace(/^net::/, "")})` : ""}.`);
  }
  if (!res.ok) throw new Error(res.status === 404 ? "That address isn't an Aatmiq server (or it's an older version without desktop support)." : `The server answered ${res.status}.`);
  return parseServerInfo(server, await res.json().catch(() => null));
}

/* ───────────── Windows ───────────── */

let connectWin: BrowserWindow | null = null;
/** The connect screen: the only page with a bridge to the app, so it never leaves its local file. */
const bridged = new WeakSet<WebContents>();
let connectState: { server: string | null; error: string | null } = { server: null, error: null };
const appWindows = new Set<BrowserWindow>();

function remoteSession(): Session {
  return session.fromPartition(PARTITION);
}

const remotePrefs = () => ({
  partition: PARTITION,
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webviewTag: false,
  spellcheck: true,
});

function openConnect(server: string | null, error: string | null = null) {
  connectState = { server, error };
  if (connectWin && !connectWin.isDestroyed()) {
    connectWin.webContents.send("connect:update", connectState);
    connectWin.show();
    connectWin.focus();
    return;
  }
  connectWin = new BrowserWindow({
    width: 520,
    height: 600,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Connect to your server",
    backgroundColor: "#0a0a0b",
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: join(__dirname, "connect-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
  });
  bridged.add(connectWin.webContents);
  connectWin.once("ready-to-show", () => connectWin?.show());
  connectWin.on("closed", () => {
    connectWin = null;
    if (!appWindows.size && process.platform !== "darwin") app.quit();
  });
  void connectWin.loadFile(join(STATIC, "connect.html"));
}

function openAppWindow(url: string) {
  const first = appWindows.size === 0;
  const b = first ? settings.bounds : undefined;
  const win = new BrowserWindow({
    width: b?.width ?? 1440,
    height: b?.height ?? 900,
    ...(b ? { x: b.x, y: b.y } : {}),
    minWidth: 640,
    minHeight: 420,
    title: settings.info?.name ?? "Aatmiq",
    backgroundColor: "#0a0a0b",
    autoHideMenuBar: process.platform !== "darwin",
    show: false,
    webPreferences: remotePrefs(),
  });
  appWindows.add(win);
  if (first && settings.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());
  win.on("close", () => {
    if (appWindows.size === 1 || first) {
      settings.bounds = win.getNormalBounds();
      settings.maximized = win.isMaximized();
      saveSettings();
    }
  });
  win.on("closed", () => appWindows.delete(win));
  void win.loadURL(url);
  return win;
}

/** Connect (or reconnect) to a server: check it, remember it, and open it. */
async function connect(address: string): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  let server: string;
  let info: ServerInfo;
  try {
    server = normalizeServer(address);
    info = await fetchInfo(server);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "That didn't work." };
  }
  settings = { ...settings, server, info };
  saveSettings();
  setInfo(info);
  for (const w of [...appWindows]) w.destroy();
  openAppWindow(`${server}${START_PATH}`);
  connectWin?.close();
  return { ok: true, name: info.name };
}

/* ───────────── What remote pages may do ───────────── */

function guard(contents: WebContents) {
  const local = () => contents.getURL().startsWith("file:");
  const route = (e: Electron.Event<{ url: string; isMainFrame: boolean }>) => {
    if (!e.isMainFrame) return;
    const d = bridged.has(contents) ? (/^(https?|mailto):/i.test(e.url) ? "external" : "block") : decideNavigation(local() ? "" : contents.getURL(), e.url, origins);
    if (d === "allow") return;
    e.preventDefault();
    if (d === "external") void shell.openExternal(e.url);
  };
  contents.on("will-navigate", route);
  contents.on("will-redirect", route);
  contents.on("will-attach-webview", (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    const d = bridged.has(contents) ? "external" : decideWindowOpen(local() ? "" : contents.getURL(), url, origins);
    if (d === "allow" && !local()) {
      // "Open in new window" from Aatmiq (an IDE workspace, a file preview): another app window.
      return { action: "allow", overrideBrowserWindowOptions: { width: 1440, height: 900, backgroundColor: "#0a0a0b", autoHideMenuBar: process.platform !== "darwin", webPreferences: remotePrefs() } };
    }
    if (d !== "block" && /^(https?|mailto):/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("did-create-window", (w) => {
    appWindows.add(w);
    w.on("closed", () => appWindows.delete(w));
  });
  // A server that can't be reached: a local page with "Try again", instead of a blank window.
  contents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || local() || bridged.has(contents)) return;
    const win = BrowserWindow.fromWebContents(contents);
    void win?.loadFile(join(STATIC, "offline.html"), { query: { url, error: description.replace(/^net::/, "") } });
  });
}

function setUpSession() {
  const ses = remoteSession();
  ses.setUserAgent(`${ses.getUserAgent()} AatmiqDesktop/${app.getVersion()}`);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => callback(permissionAllowed(permission, details.requestingUrl, origins)));
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => permissionAllowed(permission, requestingOrigin, origins));
  ses.setDevicePermissionHandler(() => false);
}

/* ───────────── Menu ───────────── */

function current(): BrowserWindow | null {
  const w = BrowserWindow.getFocusedWindow();
  return w && appWindows.has(w) ? w : ([...appWindows].at(-1) ?? null);
}

function buildMenu() {
  const mac = process.platform === "darwin";
  // Few shortcuts on purpose: keys go to the IDE (Ctrl/⌘+W closes an editor, Ctrl+R opens recent).
  const file: MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      { label: "New Window", click: () => settings.server && openAppWindow(`${settings.server}${START_PATH}`) },
      { id: "switch-server", label: "Switch Server…", click: () => openConnect(settings.server) },
      { label: "Open in Browser", click: () => {
          const u = current()?.webContents.getURL();
          if (u && /^https?:/.test(u)) void shell.openExternal(u);
        } },
      { type: "separator" },
      { label: "Close Window", accelerator: "CmdOrCtrl+Shift+W", click: () => BrowserWindow.getFocusedWindow()?.close() },
      ...(mac ? [] : [{ type: "separator" as const }, { role: "quit" as const }]),
    ],
  };
  const view: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      { label: "Reload", click: () => current()?.webContents.reload() },
      { label: "Back", click: () => current()?.webContents.navigationHistory.goBack() },
      { type: "separator" },
      { label: "Actual Size", click: () => current()?.webContents.setZoomLevel(0) },
      { label: "Zoom In", click: () => current()?.webContents.setZoomLevel((current()?.webContents.getZoomLevel() ?? 0) + 0.5) },
      { label: "Zoom Out", click: () => current()?.webContents.setZoomLevel((current()?.webContents.getZoomLevel() ?? 0) - 0.5) },
      { type: "separator" },
      { role: "togglefullscreen" },
      ...(app.isPackaged ? [] : [{ role: "toggleDevTools" as const }]),
    ],
  };
  const help: MenuItemConstructorOptions = {
    role: "help",
    submenu: [
      { label: "About Aatmiq Desktop", click: () => void dialog.showMessageBox({ type: "info", title: "Aatmiq Desktop", message: `Aatmiq Desktop ${app.getVersion()}`, detail: `Connected to ${settings.server ?? "no server yet"}.\nElectron ${process.versions.electron}, Chromium ${process.versions.chrome}.` }) },
    ],
  };
  const template: MenuItemConstructorOptions[] = mac
    ? [{ role: "appMenu" }, file, { role: "editMenu" }, view, { role: "windowMenu" }, help]
    : [file, view, help];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ───────────── aatmiq:// links ───────────── */

function handleDeepLink(link: string) {
  const d = parseDeepLink(link, settings.server);
  if (!d) return;
  if (d.kind === "open") {
    const w = current();
    if (w) {
      void w.loadURL(d.url);
      if (w.isMinimized()) w.restore();
      w.focus();
    } else openAppWindow(d.url);
  } else openConnect(d.server, `Connect to ${new URL(d.server).host} to open that link.`);
}

/* ───────────── Start ───────────── */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Installed builds open aatmiq:// links (development runs leave the system's handler alone).
  if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);

  let pendingLink: string | null = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`)) ?? null;
  app.on("open-url", (e, url) => {
    e.preventDefault();
    if (app.isReady()) handleDeepLink(url);
    else pendingLink = url;
  });
  app.on("second-instance", (_e, argv) => {
    const link = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    if (link) return handleDeepLink(link);
    const w = current() ?? connectWin;
    if (w?.isMinimized()) w.restore();
    w?.focus();
  });
  app.on("web-contents-created", (_e, contents) => guard(contents));

  ipcMain.handle("connect", async (e, address: unknown) => {
    if (!connectWin || e.sender !== connectWin.webContents) return { ok: false, error: "Not allowed." };
    return connect(String(address ?? ""));
  });
  ipcMain.handle("connect:state", (e) => (connectWin && e.sender === connectWin.webContents ? connectState : null));

  void app.whenReady().then(async () => {
    settings = loadSettings();
    setInfo(settings.info);
    setUpSession();
    buildMenu();
    if (!settings.server) openConnect(null);
    else {
      // Refresh what the server allows (an admin may have added SSO or IDE_URL); keep going offline.
      fetchInfo(settings.server).then(
        (info) => {
          settings.info = info;
          saveSettings();
          setInfo(info);
        },
        () => undefined,
      );
      openAppWindow(`${settings.server}${START_PATH}`);
    }
    if (pendingLink) handleDeepLink(pendingLink);
  });

  app.on("activate", () => {
    if (appWindows.size || connectWin) return;
    if (settings.server) openAppWindow(`${settings.server}${START_PATH}`);
    else openConnect(null);
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
