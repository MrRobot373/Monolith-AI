/**
 * Aatmiq Code: one IDE server (our Code-OSS build, apps/code) per person, started on demand.
 *
 *  - Each person has a code home (CODE_DIR/<userId>, 0700) with their workspaces and IDE data,
 *    owned by their own Unix user when the API runs as root (same isolation as Work AI tasks).
 *  - The server listens on a Unix socket inside that home; only the API (and the person's own
 *    processes) can reach it. Browsers reach it through /code/ide/, proxied with the Aatmiq session.
 *  - It stops after a while without open connections and starts again on the next visit.
 * See docs/07-code.md.
 */
import { codeUser, eq, user, type DB } from "@aatmiq/db";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, chown, mkdir, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import type { AppContext } from "../context";
import { HttpError } from "../errors";

export const IDE_BASE_PATH = "/code/ide";

interface IdeServer {
  userId: string;
  uid: number | null;
  socket: string;
  token: string;
  proc: ChildProcess;
  ready: Promise<void>;
  lastActive: number;
  connections: number;
  exited: boolean;
}

const NSS_WRAPPER = ["/usr/lib/x86_64-linux-gnu/libnss_wrapper.so", "/usr/lib/aarch64-linux-gnu/libnss_wrapper.so", "/usr/lib64/libnss_wrapper.so", "/usr/lib/libnss_wrapper.so"].find((p) =>
  existsSync(p),
);

/** A Unix login name from an email address ("asha.k@acme.com" → "asha.k"). */
export function loginName(email: string): string {
  return (
    email
      .split("@")[0]!
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "")
      .replace(/^[^a-z_]+/, "")
      .slice(0, 32) || "aatmiq"
  );
}

export function codeDistDir(): string {
  return resolve(process.env.AATMIQ_CODE_DIST ?? join(process.cwd(), "..", "code", "dist", "aatmiq-code"));
}

/** Folder-safe workspace name. */
export function codeSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|-+$/g, "")
      .slice(0, 48) || "workspace"
  );
}

export class CodeServers {
  private servers = new Map<string, IdeServer>();
  private starting = new Map<string, Promise<IdeServer>>();
  private tokens = new Map<string, string>();
  private sweeper?: NodeJS.Timeout;

  constructor(
    private ctx: AppContext,
    private opts: { controlUrl: () => string; idleMinutes?: number; log?: (msg: string, err?: unknown) => void },
  ) {}

  get root() {
    return resolve(this.ctx.cfg.codeDir ?? ".data/code");
  }
  get isolated() {
    return process.getuid?.() === 0 && this.ctx.cfg.workIsolation !== "off";
  }
  get installed() {
    return existsSync(join(codeDistDir(), "out", "server-main.js"));
  }
  home(userId: string) {
    return join(this.root, userId);
  }
  workspacePath(userId: string, slug: string) {
    return join(this.home(userId), "workspaces", slug);
  }

  /** The person's Unix user id (allocated once). */
  async uidFor(userId: string): Promise<number> {
    const db: DB = this.ctx.db;
    const [row] = await db.select({ uid: codeUser.uid }).from(codeUser).where(eq(codeUser.userId, userId));
    if (row) return row.uid;
    await db.insert(codeUser).values({ userId }).onConflictDoNothing();
    const [again] = await db.select({ uid: codeUser.uid }).from(codeUser).where(eq(codeUser.userId, userId));
    return again!.uid;
  }

  /** Create the code home (and optionally a folder in it) owned by the person's user. */
  async prepare(userId: string, extra?: string): Promise<number | null> {
    const home = this.home(userId);
    await mkdir(join(home, "workspaces"), { recursive: true });
    await mkdir(join(home, ".ide"), { recursive: true });
    if (extra) await mkdir(extra, { recursive: true });
    if (!this.isolated) return null;
    const uid = await this.uidFor(userId);
    await chmod(this.root, 0o711);
    for (const p of [home, join(home, "workspaces"), join(home, ".ide"), ...(extra ? [extra] : [])]) await chown(p, uid, uid);
    await chmod(home, 0o700);
    await chmod(join(home, ".ide"), 0o700);
    return uid;
  }

  /** Running server for a person, started if needed. */
  async ensure(userId: string): Promise<IdeServer> {
    const live = this.servers.get(userId);
    if (live && !live.exited) {
      await live.ready;
      return live;
    }
    let p = this.starting.get(userId);
    if (!p) {
      p = this.start(userId).finally(() => this.starting.delete(userId));
      this.starting.set(userId, p);
    }
    return p;
  }

  private async start(userId: string): Promise<IdeServer> {
    if (!this.installed) throw new HttpError(503, "Aatmiq Code isn't installed on this server. Build it with `pnpm --filter @aatmiq/code build`.", "code_unavailable");
    const uid = await this.prepare(userId);
    const home = this.home(userId);
    const socket = join(home, ".ide", "ide.sock");
    await rm(socket, { force: true });
    const token = randomBytes(32).toString("hex");
    const dist = codeDistDir();
    const [person] = await this.ctx.db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, userId));
    const login = loginName(person?.email ?? "");
    // The person's user has no entry in /etc/passwd; nss_wrapper gives terminals and tools a name,
    // home and shell without touching the system files.
    const identity: Record<string, string> = { USER: login, LOGNAME: login };
    if (uid !== null && NSS_WRAPPER) {
      const ide = join(home, ".ide");
      const gecos = (person?.name ?? login).replace(/[:\n]/g, " ");
      await writeFile(join(ide, "passwd"), `root:x:0:0:root:/root:/bin/bash\n${login}:x:${uid}:${uid}:${gecos}:${home}:/bin/bash\n`);
      await writeFile(join(ide, "group"), `root:x:0:\n${login}:x:${uid}:\n`);
      Object.assign(identity, { LD_PRELOAD: NSS_WRAPPER, NSS_WRAPPER_PASSWD: join(ide, "passwd"), NSS_WRAPPER_GROUP: join(ide, "group") });
    }
    if (person) {
      // Commits made in the IDE are signed with the person's Aatmiq name and email (they can change it).
      Object.assign(identity, { GIT_AUTHOR_NAME: person.name, GIT_AUTHOR_EMAIL: person.email, GIT_COMMITTER_NAME: person.name, GIT_COMMITTER_EMAIL: person.email });
    }
    // node + server-main directly (the bin script would leave node orphaned on stop), in its own
    // process group so stopping it also ends its terminals and extension hosts.
    const proc = spawn(
      join(dist, "node"),
      [
        join(dist, "out", "server-main.js"),
        "--socket-path", socket,
        "--server-base-path", IDE_BASE_PATH,
        // The socket is private to the person and the API; the proxy checks the Aatmiq session.
        "--without-connection-token",
        "--server-data-dir", join(home, ".aatmiq-code-server"),
        "--disable-workspace-trust",
        "--telemetry-level", "off",
      ],
      {
        cwd: home,
        // Only what an IDE needs: nothing from the API's own environment.
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: home,
          SHELL: "/bin/bash",
          LANG: process.env.LANG ?? "C.UTF-8",
          TZ: process.env.TZ ?? "UTC",
          ...identity,
          AATMIQ_CONTROL_URL: this.opts.controlUrl(),
          AATMIQ_CODE_TOKEN: token,
          ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
        },
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
        ...(uid !== null ? { uid, gid: uid } : {}),
      },
    );
    let stderr = "";
    proc.stderr?.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-2000);
    });
    const server: IdeServer = { userId, uid, socket, token, proc, ready: Promise.resolve(), lastActive: Date.now(), connections: 0, exited: false };
    proc.on("exit", () => {
      server.exited = true;
      this.tokens.delete(token);
      if (this.servers.get(userId) === server) this.servers.delete(userId);
    });
    server.ready = this.waitForSocket(socket, proc, () => stderr);
    this.servers.set(userId, server);
    this.tokens.set(token, userId);
    try {
      await server.ready;
    } catch (e) {
      try {
        process.kill(-proc.pid!, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
      throw e;
    }
    this.sweep();
    return server;
  }

  private async waitForSocket(socket: string, proc: ChildProcess, stderr: () => string) {
    for (let i = 0; i < 100; i++) {
      if (proc.exitCode !== null) throw new HttpError(500, `The IDE couldn't start. ${stderr().trim().split("\n").slice(-2).join(" ")}`, "code_failed");
      if (existsSync(socket)) {
        const ok = await new Promise<boolean>((r) => {
          const c = connect(socket, () => {
            c.end();
            r(true);
          });
          c.on("error", () => r(false));
        });
        if (ok) return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new HttpError(504, "The IDE took too long to start.", "code_timeout");
  }

  /** The person whose IDE holds this token (for the Aatmiq panel's calls). */
  fromToken(token: string): string | null {
    return this.tokens.get(token) ?? null;
  }

  running(userId: string) {
    const s = this.servers.get(userId);
    return !!s && !s.exited;
  }

  touch(server: IdeServer) {
    server.lastActive = Date.now();
  }

  private sweep() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const idleMs = (this.opts.idleMinutes ?? 30) * 60_000;
      for (const s of this.servers.values()) {
        if (s.connections === 0 && Date.now() - s.lastActive > idleMs) void this.stop(s.userId);
      }
    }, 60_000);
    this.sweeper.unref();
  }

  async stop(userId: string) {
    const s = this.servers.get(userId);
    if (!s) return;
    this.servers.delete(userId);
    this.tokens.delete(s.token);
    if (s.exited) return;
    const signal = (sig: NodeJS.Signals) => {
      try {
        process.kill(-s.proc.pid!, sig);
      } catch {
        s.proc.kill(sig);
      }
    };
    signal("SIGTERM");
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        signal("SIGKILL");
        r();
      }, 5000);
      s.proc.once("exit", () => {
        clearTimeout(t);
        r();
      });
    });
  }

  async stopAll() {
    clearInterval(this.sweeper);
    await Promise.all([...this.servers.keys()].map((u) => this.stop(u)));
  }
}
