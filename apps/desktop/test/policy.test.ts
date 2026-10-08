import { describe, expect, it } from "vitest";
import { decideNavigation, decideWindowOpen, isLocalHost, normalizeServer, parseDeepLink, parseServerInfo, permissionAllowed, type Origins } from "../src/policy";

const o: Origins = { app: ["https://aatmiq.acme.com", "https://ide.acme.com"], signIn: ["https://accounts.google.com", "https://login.microsoftonline.com"] };

describe("server address", () => {
  it("takes what people type and keeps only the origin", () => {
    expect(normalizeServer("aatmiq.acme.com")).toBe("https://aatmiq.acme.com");
    expect(normalizeServer(" https://aatmiq.acme.com/app/code?x=1 ")).toBe("https://aatmiq.acme.com");
    expect(normalizeServer("https://aatmiq.acme.com:8443/")).toBe("https://aatmiq.acme.com:8443");
    expect(normalizeServer("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeServer("http://10.0.0.5:3000")).toBe("http://10.0.0.5:3000");
    expect(normalizeServer("http://aatmiq:3000")).toBe("http://aatmiq:3000");
  });
  it("refuses plain http on the internet, other schemes and credentials", () => {
    expect(() => normalizeServer("http://aatmiq.acme.com")).toThrow("https");
    expect(() => normalizeServer("ftp://aatmiq.acme.com")).toThrow("https");
    expect(() => normalizeServer("file:///etc/passwd")).toThrow();
    expect(() => normalizeServer("https://me:pw@aatmiq.acme.com")).toThrow("user name");
    expect(() => normalizeServer("")).toThrow("Enter");
    expect(() => normalizeServer("https://exa mple.com")).toThrow();
  });
  it("knows local and private hosts", () => {
    for (const h of ["localhost", "127.0.0.1", "192.168.1.20", "172.20.0.2", "dev.local", "ci.internal", "aatmiq", "[::1]"]) expect(isLocalHost(h), h).toBe(true);
    for (const h of ["aatmiq.acme.com", "8.8.8.8", "172.32.0.1"]) expect(isLocalHost(h), h).toBe(false);
  });
});

describe("server info", () => {
  it("accepts Aatmiq's answer and keeps only usable origins", () => {
    const info = parseServerInfo("https://aatmiq.acme.com", {
      product: "aatmiq",
      name: "Acme AI",
      appOrigin: "https://aatmiq.acme.com/",
      ideOrigin: "https://ide.acme.com",
      signInOrigins: ["https://accounts.google.com", "http://insecure.example", "http://localhost:8080", "javascript:alert(1)", 5],
    });
    expect(info).toEqual({ product: "aatmiq", name: "Acme AI", appOrigin: "https://aatmiq.acme.com", ideOrigin: "https://ide.acme.com", signInOrigins: ["https://accounts.google.com", "http://localhost:8080"] });
  });
  it("refuses anything else", () => {
    expect(() => parseServerInfo("https://x.com", { hello: "world" })).toThrow("isn't an Aatmiq server");
    expect(() => parseServerInfo("https://x.com", null)).toThrow("isn't an Aatmiq server");
    expect(() => parseServerInfo("https://x.com", { product: "aatmiq", appOrigin: "file:///x" })).toThrow("can't use");
  });
});

describe("navigation", () => {
  it("keeps Aatmiq, its IDE host and sign-in providers in the app", () => {
    expect(decideNavigation("https://aatmiq.acme.com/app", "https://aatmiq.acme.com/app/code", o)).toBe("allow");
    expect(decideNavigation("https://aatmiq.acme.com/app/code/1", "https://ide.acme.com/code/ide/?x", o)).toBe("allow");
    expect(decideNavigation("https://aatmiq.acme.com/login", "https://accounts.google.com/o/oauth2/auth?x", o)).toBe("allow");
  });
  it("sends other links from Aatmiq to the browser, and blocks local files and scripts", () => {
    expect(decideNavigation("https://aatmiq.acme.com/app", "https://github.com/acme/repo", o)).toBe("external");
    expect(decideNavigation("https://aatmiq.acme.com/app", "http://intranet/wiki", o)).toBe("external");
    expect(decideNavigation("https://aatmiq.acme.com/app", "mailto:help@acme.com", o)).toBe("external");
    expect(decideNavigation("https://aatmiq.acme.com/app", "file:///etc/passwd", o)).toBe("block");
    expect(decideNavigation("https://aatmiq.acme.com/app", "javascript:alert(1)", o)).toBe("block");
    expect(decideNavigation("https://aatmiq.acme.com/app", "vscode://file/x", o)).toBe("block");
    expect(decideNavigation("", "https://github.com", o)).toBe("external");
  });
  it("follows a sign-in provider's own hand-overs (https only) back to Aatmiq", () => {
    expect(decideNavigation("https://login.microsoftonline.com/x", "https://adfs.acme.com/adfs/ls", o)).toBe("allow");
    expect(decideNavigation("https://adfs.acme.com/adfs/ls", "https://aatmiq.acme.com/api/auth/callback", o)).toBe("allow");
    expect(decideNavigation("https://adfs.acme.com/adfs/ls", "http://plain.example", o)).toBe("external");
  });
});

describe("new windows", () => {
  it("lets Aatmiq open a blank window to point at the IDE; nobody else", () => {
    expect(decideWindowOpen("https://aatmiq.acme.com/app/code/1", "about:blank", o)).toBe("allow");
    expect(decideWindowOpen("https://accounts.google.com/x", "about:blank", o)).toBe("block");
    expect(decideWindowOpen("", "about:blank", o)).toBe("block");
    expect(decideWindowOpen("https://aatmiq.acme.com/app", "https://ide.acme.com/code/ide/", o)).toBe("allow");
    expect(decideWindowOpen("https://aatmiq.acme.com/app", "https://example.com", o)).toBe("external");
  });
});

describe("permissions", () => {
  it("lets Aatmiq use the clipboard and notifications, nothing else and no one else", () => {
    expect(permissionAllowed("clipboard-read", "https://ide.acme.com/code/ide/", o)).toBe(true);
    expect(permissionAllowed("notifications", "https://aatmiq.acme.com/app", o)).toBe(true);
    expect(permissionAllowed("geolocation", "https://aatmiq.acme.com/app", o)).toBe(false);
    expect(permissionAllowed("media", "https://aatmiq.acme.com/app", o)).toBe(false);
    expect(permissionAllowed("clipboard-read", "https://accounts.google.com/", o)).toBe(false);
    expect(permissionAllowed("clipboard-read", "", o)).toBe(false);
  });
});

describe("aatmiq:// links", () => {
  it("opens paths on the connected server, and only offers to connect to another", () => {
    expect(parseDeepLink("aatmiq://open?server=https://aatmiq.acme.com&path=/app/code/abc", "https://aatmiq.acme.com")).toEqual({ kind: "open", url: "https://aatmiq.acme.com/app/code/abc" });
    expect(parseDeepLink("aatmiq://open?server=aatmiq.acme.com", "https://aatmiq.acme.com")).toEqual({ kind: "open", url: "https://aatmiq.acme.com/app/code" });
    expect(parseDeepLink("aatmiq://open?server=https://evil.example&path=/app", "https://aatmiq.acme.com")).toEqual({ kind: "connect", server: "https://evil.example" });
    expect(parseDeepLink("aatmiq://open?server=https://aatmiq.acme.com&path=//evil.example/x", "https://aatmiq.acme.com")).toEqual({ kind: "open", url: "https://aatmiq.acme.com/app/code" });
    expect(parseDeepLink("aatmiq://open?server=https://aatmiq.acme.com&path=https://evil.example", "https://aatmiq.acme.com")).toEqual({ kind: "open", url: "https://aatmiq.acme.com/app/code" });
    expect(parseDeepLink("https://aatmiq.acme.com", null)).toBeNull();
    expect(parseDeepLink("aatmiq://open", null)).toBeNull();
  });
});
