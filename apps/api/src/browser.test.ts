/**
 * The Work AI browser against a local test site: page views with numbered elements, forms held
 * until confirmed, downloads and screenshots in the task folder, the private-network rules, and
 * running as the task's own user. Needs Chromium (BROWSER_PATH or Playwright's copy).
 */
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { existsSync, statSync } from "node:fs";
import { chmod, chown, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserError, BrowserService, findChromium, type BrowserTarget } from "./services/browser";
import { hostAllowed, isPrivateAddress, startEgressProxy, type EgressProxy } from "./services/egress";

describe("egress rules", () => {
  it("knows private, internal and reserved addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "224.0.0.1"])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
    expect(isPrivateAddress("not-an-ip")).toBe(true);
  });
  it("matches allowed hosts exactly or by *.suffix", () => {
    expect(hostAllowed("intranet.acme.com", ["intranet.acme.com"])).toBe(true);
    expect(hostAllowed("wiki.acme.internal", ["*.acme.internal"])).toBe(true);
    expect(hostAllowed("acme.internal", ["*.acme.internal"])).toBe(false);
    expect(hostAllowed("evilacme.internal", ["*.acme.internal"])).toBe(false);
    expect(hostAllowed("x.acme.com", ["intranet.acme.com"])).toBe(false);
  });
});

// Container mode: the proxy listens for task containers, which must bring a token whose task may go out.
describe("the egress proxy for task containers", () => {
  const ip = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
  (ip ? it : it.skip)("serves other machines only with the token of a task that may go out", async () => {
    const target = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const tport = (target.address() as { port: number }).port;
    const p = await startEgressProxy({ allowedHosts: () => ["site.test"], upstream: null, host: "0.0.0.0", authorize: (t) => t === "good", resolve: async () => ["127.0.0.1"] });
    const port = Number(new URL(p.url).port);
    const ask = (from: string, line: string, auth?: string) =>
      new Promise<string>((resolve) => {
        const header = auth ? `Proxy-Authorization: Basic ${Buffer.from(auth).toString("base64")}\r\n` : "";
        const s = connect(port, from, () => s.write(`${line}\r\nHost: site.test:${tport}\r\n${header}\r\n`));
        s.once("data", (d) => {
          resolve(d.toString().split("\r\n")[0]!);
          s.destroy();
        });
      });
    const tunnel = `CONNECT site.test:${tport} HTTP/1.1`;
    expect(await ask(ip!, tunnel)).toBe("HTTP/1.1 407 Proxy Authentication Required");
    expect(await ask(ip!, tunnel, "task:bad")).toBe("HTTP/1.1 403 Forbidden");
    expect(await ask(ip!, tunnel, "task:good")).toBe("HTTP/1.1 200 Connection Established");
    expect(await ask(ip!, `GET http://site.test:${tport}/ HTTP/1.1`)).toBe("HTTP/1.1 407 Proxy Authentication Required");
    expect(await ask(ip!, `GET http://site.test:${tport}/ HTTP/1.1`, "task:good")).toBe("HTTP/1.1 200 OK");
    // This machine's own browser needs no token.
    expect(await ask("127.0.0.1", tunnel)).toBe("HTTP/1.1 200 Connection Established");
    await p.close();
    target.close();
  });
});

/** A small site with the things agents meet: links, a form, a drop-down, JavaScript, a download. */
function startSite(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const html = (body: string, title = "Shop") => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>${title}</title><body>${body}</body>`);
    };
    if (u.pathname === "/") {
      return html(`<h1>Sock shop</h1><p>Warm socks for winter.</p>
        <a href="/about">About us</a> <a href="/socks.csv">Price list</a> <a href="/long">Long page</a> <a href="/app">App</a>
        <form action="/search" method="get"><label for="q">Search</label><input id="q" name="q"><button type="submit">Find</button></form>
        <form action="/order" method="post"><select name="size"><option>Small</option><option>Large</option></select>
        <label><input type="checkbox" name="gift"> Gift wrap</label><button>Order</button><button type="button" onclick="this.textContent='Clicked'">Help</button></form>`);
    }
    if (u.pathname === "/about") return html("<h1>About</h1><p>Family business since 1950.</p>", "About");
    if (u.pathname === "/search") return html(`<h1>Results for ${u.searchParams.get("q")}</h1>`, "Results");
    if (u.pathname === "/order") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => html(`<h1>Ordered</h1><p>${body}</p>`, "Ordered"));
      return;
    }
    if (u.pathname === "/socks.csv") {
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="socks.csv"' });
      return res.end("sock,price\nwool,12\n");
    }
    if (u.pathname === "/long") return html(`<h1>Long</h1>${Array.from({ length: 3000 }, (_, i) => `<p>Line ${i} of the long page.</p>`).join("")}`, "Long");
    if (u.pathname === "/app") return html(`<div id="root"></div><script>setTimeout(()=>{document.getElementById("root").innerHTML="<h2>Rendered by JavaScript</h2>"},50)</script>`, "App");
    res.writeHead(404).end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: (server.address() as { port: number }).port })));
}

const chrome = findChromium();
(chrome ? describe : describe.skip)("the Work AI browser", () => {
  let site: { server: Server; port: number };
  let egress: EgressProxy;
  let browser: BrowserService;
  let work = "";
  let base = "";
  const target = (extra: Partial<BrowserTarget> = {}) => async (): Promise<BrowserTarget> => ({ workdir: work, profileDir: join(work, "..", "profile"), ...extra });

  beforeAll(async () => {
    site = await startSite();
    // site.test is "internal" (127.0.0.1) and allowed; anything else that resolves privately isn't.
    egress = await startEgressProxy({
      allowedHosts: () => browser.allowedHosts,
      upstream: null,
      resolve: async (h) => (h === "site.test" || h === "sneaky.test" ? ["127.0.0.1"] : h === "mixed.test" ? ["93.184.216.34", "10.0.0.5"] : []),
    });
    browser = new BrowserService({ executablePath: chrome, egress: async () => egress, runtimeDir: await mkdtemp(join(tmpdir(), "aatmiq-brt-")) });
    browser.allowedHosts = ["site.test"];
    work = join(await mkdtemp(join(tmpdir(), "aatmiq-task-")), "files");
    base = `http://site.test:${site.port}`;
  });
  afterAll(async () => {
    await browser?.closeAll();
    await egress?.close();
    site?.server.close();
  });

  it("the proxy refuses private addresses unless allowed, also for HTTPS tunnels", async () => {
    await expect(egress.check("sneaky.test")).rejects.toThrow("private or internal");
    await expect(egress.check("mixed.test")).rejects.toThrow("private or internal");
    await expect(egress.check("169.254.169.254")).rejects.toThrow("private or internal");
    await expect(egress.check("localhost")).rejects.toThrow("internal name");
    expect(await egress.check("site.test")).toBe("127.0.0.1");
    const status = await new Promise<string>((resolve) => {
      const u = new URL(egress.url);
      const s = connect(Number(u.port), u.hostname, () => s.write("CONNECT sneaky.test:443 HTTP/1.1\r\nHost: sneaky.test:443\r\n\r\n"));
      s.once("data", (d) => {
        resolve(d.toString().split("\r\n")[0]!);
        s.destroy();
      });
    });
    expect(status).toBe("HTTP/1.1 403 Forbidden");
  });

  it("behind a corporate proxy: public sites go through it, allowed internal hosts don't", async () => {
    const seen: string[] = [];
    const corp = createServer();
    corp.on("connect", (req, sock) => {
      seen.push(String(req.url));
      sock.end("HTTP/1.1 200 Connection Established\r\n\r\n");
    });
    await new Promise<void>((r) => corp.listen(0, "127.0.0.1", r));
    const viaCorp = await startEgressProxy({
      allowedHosts: () => ["site.test"],
      upstream: `http://127.0.0.1:${(corp.address() as { port: number }).port}`,
      resolve: async (h) => (h === "site.test" ? ["127.0.0.1"] : h === "public.test" ? ["93.184.216.34"] : Promise.reject(new Error("no dns"))),
    });
    const tunnel = (target: string) =>
      new Promise<string>((resolve) => {
        const u = new URL(viaCorp.url);
        const s = connect(Number(u.port), u.hostname, () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
        s.once("data", (d) => {
          resolve(d.toString().split("\r\n")[0]!);
          s.destroy();
        });
      });
    expect(await tunnel("public.test:443")).toBe("HTTP/1.1 200 Connection Established");
    // Unknown to local DNS: the corporate proxy resolves it.
    expect(await tunnel("elsewhere.test:443")).toBe("HTTP/1.1 200 Connection Established");
    expect(await tunnel(`site.test:${site.port}`)).toBe("HTTP/1.1 200 Connection Established");
    expect(seen).toEqual(["public.test:443", "elsewhere.test:443"]);
    await viaCorp.close();
    corp.close();
  });

  it("opens a page as text with numbered elements", async () => {
    const v = await browser.open("t1", target(), base);
    expect(v.title).toBe("Shop");
    expect(v.text).toContain("# Sock shop");
    expect(v.text).toContain("Warm socks for winter.");
    expect(v.text).toMatch(/\[1\] link "About us" → \/about/);
    expect(v.text).toMatch(/\[\d+\] textbox "Search"/);
    expect(v.text).toMatch(/\[\d+\] select "" \(selected: Small; options: Small \| Large\)|\[\d+\] select ".*" \(selected: Small/);
    expect(v.text).toMatch(/\[\d+\] checkbox "Gift wrap" \(not checked\)/);
  }, 60_000);

  it("follows links; buttons that don't submit just click", async () => {
    const about = await browser.click("t1", target(), 1, false);
    expect(about.text).toContain("Family business since 1950.");
    const back = await browser.back("t1", target());
    expect(back.title).toBe("Shop");
    const help = Number(/\[(\d+)\] button "Help"/.exec(back.text)![1]);
    expect((await browser.click("t1", target(), help, false)).text).toMatch(/button "Clicked"/);
  }, 60_000);

  it("holds form submissions until confirmed (Enter and submit buttons)", async () => {
    const v = await browser.open("t1", target(), base);
    const search = Number(/\[(\d+)\] textbox "Search"/.exec(v.text)![1]);
    await expect(browser.type("t1", target(), search, "wool", true, false)).rejects.toThrow("confirm_submit: true");
    const results = await browser.type("t1", target(), search, "wool", true, true);
    expect(results.text).toContain("Results for wool");

    const v2 = await browser.open("t1", target(), base);
    const size = Number(/\[(\d+)\] select/.exec(v2.text)![1]);
    const gift = Number(/\[(\d+)\] checkbox "Gift wrap"/.exec(v2.text)![1]);
    const order = Number(/\[(\d+)\] button "Order"/.exec(v2.text)![1]);
    expect((await browser.select("t1", target(), size, "Large")).text).toContain("selected: Large");
    expect((await browser.click("t1", target(), gift, false)).text).toMatch(/checkbox "Gift wrap" \(checked\)/);
    const held = await browser.click("t1", target(), order, false).catch((e: unknown) => e);
    expect(held).toBeInstanceOf(BrowserError);
    expect((held as Error).message).toContain("submits a form");
    const done = await browser.click("t1", target(), order, true);
    expect(done.text).toContain("size=Large&gift=on");
    await expect(browser.click("t1", target(), 999, false)).rejects.toThrow("no element [999]");
  }, 60_000);

  it("waits for JavaScript-rendered pages, reads long pages in parts, saves downloads and screenshots", async () => {
    expect((await browser.open("t1", target(), `${base}/app`)).text).toContain("Rendered by JavaScript");
    const long = await browser.open("t1", target(), `${base}/long`);
    expect(long.truncated).toBe(true);
    const more = await browser.read("t1", target(), long.text.length);
    expect(more.offset).toBe(long.text.length);
    expect(more.text).not.toContain("Line 0 of");

    const home = await browser.open("t1", target(), base);
    const csv = Number(/\[(\d+)\] link "Price list"/.exec(home.text)![1]);
    await browser.click("t1", target(), csv, false).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 500));
    expect(await readFile(join(work, "downloads", "socks.csv"), "utf8")).toContain("wool,12");

    const shot = await browser.screenshot("t1", target(), false);
    expect(shot.file).toMatch(/^screenshots\/screenshot-.*\.png$/);
    const png = await readFile(join(work, shot.file));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  }, 60_000);

  it("refuses the private network, other schemes and non-addresses with a clear reason", async () => {
    await expect(browser.open("t1", target(), `http://sneaky.test:${site.port}/`)).rejects.toThrow("private network");
    await expect(browser.open("t1", target(), `http://127.0.0.1:${site.port}/`)).rejects.toThrow("private network");
    await expect(browser.open("t1", target(), "file:///etc/passwd")).rejects.toThrow("Only http and https");
    await expect(browser.open("t1", target(), "javascript:alert(1)")).rejects.toThrow("Only http and https");
  }, 60_000);

  it.runIf(process.getuid?.() === 0)("runs as the task's own Unix user", async () => {
    // Like a real task folder: the work root is open to enter, the task's folder is its user's alone.
    const root = await mkdtemp(join(tmpdir(), "aatmiq-workroot-"));
    await chmod(root, 0o755);
    // A deep folder, like /data/work/<task id>/…: Chromium's sockets must not end up under it.
    const taskDir = join(root, "a-folder-name-long-enough-to-matter", "e437508c-bc68-49d0-9bd1-fd7eabeb377a");
    await mkdir(join(taskDir, "files"), { recursive: true });
    await mkdir(join(taskDir, "runtime"), { recursive: true });
    for (const d of [taskDir, join(taskDir, "files"), join(taskDir, "runtime")]) await chown(d, 4321, 4321);
    await chmod(taskDir, 0o700);
    const t = target({ uid: 4321, workdir: join(taskDir, "files"), profileDir: join(taskDir, "runtime", "browser") });
    await browser.open("t2", t, base);
    const shot = await browser.screenshot("t2", t, false);
    expect(statSync(join(taskDir, "files", shot.file)).uid).toBe(4321);
    expect(execFileSync("ps", ["-eo", "uid,comm"]).toString()).toMatch(/^\s*4321\s+chrome/m);
    await browser.close("t2");
    // Chromium's helper processes take a moment to exit after the browser closes.
    const running = () => /^\s*4321\s+chrome/m.test(execFileSync("ps", ["-eo", "uid,comm"]).toString());
    for (let i = 0; i < 50 && running(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(running()).toBe(false);
  }, 60_000);
});
