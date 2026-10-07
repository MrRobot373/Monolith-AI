/**
 * Container mode (P2.1, D5): each task's runtime runs in its own Docker container, started with
 * `docker run -i` so stdio carries the same JSON-RPC as in process mode.
 *
 *  - only the task's folder is mounted (read-write), at the same path; the root filesystem is
 *    read-only, /tmp is a private tmpfs, every capability is dropped, no new privileges;
 *  - CPU, memory (no swap beyond it) and process limits per task;
 *  - an internal Docker network that reaches only Aatmiq; the internet, when allowed, only through
 *    Aatmiq's egress proxy (no private addresses), which knows the task by a credential derived from
 *    its token (commands see that one, never the token itself), or none at all;
 *  - secrets (the task token) reach the container through the docker CLI's environment, never its
 *    command line, so they don't show in a process list.
 */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { dirname, relative } from "node:path";
import type { TaskSpec } from "../types";
import type { Launcher } from "./engine";

export interface ContainerLimits {
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
  /** "proxy": public internet through Aatmiq's egress proxy. "none": only Aatmiq itself. */
  network: "proxy" | "none";
}

export interface ContainerOptions {
  /** The docker CLI (default "docker"). */
  docker?: string;
  /** Image with node, the agent runtime and the plugin at the same paths as here (the API image). */
  image: string;
  /** Docker network the task joins (internal: it reaches only Aatmiq). */
  network: string;
  /**
   * Where task folders live on the Docker host: a named volume mounted at `root` in this container
   * (the folder is mounted by sub-path), or null when the paths here are the host's own (bind).
   */
  volume: { name: string; root: string } | null;
  /** Aatmiq's egress proxy as the task network reaches it (http://aatmiq-api:3128). */
  proxyUrl: string | null;
  /** Hosts that never go through the proxy (Aatmiq's own address). */
  noProxy: string[];
  limits: ContainerLimits;
}

/** The task's egress proxy password: tied to the task token, but useless against Aatmiq's API. */
export const egressToken = (token: string) => createHmac("sha256", token).update("aatmiq-egress").digest("hex");

export const containerName = (taskId: string) => `aatmiq-task-${taskId.replace(/[^a-zA-Z0-9_.-]/g, "")}`;
export const TASK_LABEL = "aatmiq.task";

/** The `docker run` arguments for a task (exported for tests). Values of `env` never appear here. */
export function containerArgs(o: ContainerOptions, a: { cli: string; argv: string[]; cwd: string; env: NodeJS.ProcessEnv; spec: TaskSpec }): string[] {
  const taskDir = dirname(a.spec.homeDir);
  const mount = o.volume
    ? `type=volume,src=${o.volume.name},dst=${taskDir},volume-subpath=${relative(o.volume.root, taskDir)}`
    : `type=bind,src=${taskDir},dst=${taskDir}`;
  if (o.volume && relative(o.volume.root, taskDir).startsWith("..")) throw new Error(`The task folder ${taskDir} isn't inside the volume root ${o.volume.root}.`);
  const user = a.spec.uid !== undefined ? ["--user", `${a.spec.uid}:${a.spec.gid ?? a.spec.uid}`] : [];
  const l = a.spec.container ?? o.limits;
  return [
    "run", "-i", "--rm", "--init",
    "--name", containerName(a.spec.taskId),
    "--label", `${TASK_LABEL}=${a.spec.taskId}`,
    ...user,
    "--network", o.network,
    "--cpus", String(l.cpus),
    "--memory", `${l.memoryMb}m`,
    "--memory-swap", `${l.memoryMb}m`,
    "--pids-limit", String(l.pidsLimit),
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--read-only",
    "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=1g",
    // The image declares its data folder a volume; an empty root-owned tmpfs there instead of a
    // fresh writable volume, so the task folder is the only place outside /tmp it can write.
    ...(o.volume ? ["--tmpfs", `${o.volume.root}:rw,noexec,nosuid,nodev,size=1m,mode=755`] : []),
    "--mount", mount,
    "--workdir", a.cwd,
    ...Object.keys(a.env).flatMap((k) => ["--env", k]),
    "--entrypoint", "node",
    o.image,
    a.cli,
    ...a.argv,
  ];
}

/** The environment inside the container: the runtime's own, with the network settings for this mode. */
export function containerEnv(o: ContainerOptions, env: NodeJS.ProcessEnv, spec?: TaskSpec): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE"]) delete out[k];
  if ((spec?.container ?? o.limits).network === "proxy" && o.proxyUrl) {
    // The proxy knows the task by it (and refuses tasks without internet).
    const u = new URL(o.proxyUrl);
    if (spec) [u.username, u.password] = ["task", egressToken(spec.token)];
    const proxy = u.href.replace(/\/$/, "");
    const noProxy = ["localhost", "127.0.0.1", ...o.noProxy].join(",");
    Object.assign(out, { HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy, NO_PROXY: noProxy, no_proxy: noProxy });
  }
  return out;
}

export function containerLauncher(o: ContainerOptions): Launcher {
  const docker = o.docker ?? "docker";
  return {
    spawn(a) {
      const env = containerEnv(o, a.env, a.spec);
      const args = containerArgs(o, { ...a, env });
      // The docker CLI reads each --env value from its own environment.
      const child = spawn(docker, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}), DOCKER_CONFIG: "/tmp/aatmiq-docker", ...env },
      });
      // If the CLI is killed outright the container would keep running: remove it.
      child.on("exit", () => {
        spawn(docker, ["rm", "-f", containerName(a.spec.taskId)], { stdio: "ignore", env: { PATH: process.env.PATH ?? "/usr/bin:/bin", DOCKER_CONFIG: "/tmp/aatmiq-docker", ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) } }).on("error", () => undefined);
      });
      return child;
    },
  };
}

/** Remove task containers left over from before a restart. */
export function removeStaleContainers(docker = "docker"): Promise<void> {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", DOCKER_CONFIG: "/tmp/aatmiq-docker", ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) };
    const ls = spawn(docker, ["ps", "-aq", "--filter", `label=${TASK_LABEL}`], { env });
    let ids = "";
    ls.stdout.on("data", (d: Buffer) => (ids += d.toString()));
    ls.on("error", () => resolve());
    ls.on("close", () => {
      const list = ids.split(/\s+/).filter(Boolean);
      if (!list.length) return resolve();
      spawn(docker, ["rm", "-f", ...list], { stdio: "ignore", env }).on("close", () => resolve()).on("error", () => resolve());
    });
  });
}
