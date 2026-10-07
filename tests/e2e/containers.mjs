/**
 * Container mode (WORK_ISOLATION=container) against a running Compose stack: what a task's
 * container can and can't do, its limits, and that containers are cleaned up.
 * Usage: tests/e2e/run-containers.sh   (needs the aatmiq-api:dev and aatmiq-web:dev images)
 */
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";

const APP = process.env.BASE_URL ?? "http://localhost:3999";
const results = [];
let cookie = "";
const expect = (c, m) => {
  if (!c) throw new Error(m);
};
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, err: e.message.slice(0, 400) });
  }
}
async function api(method, path, body) {
  const r = await fetch(`${APP}${path}`, { method, headers: { origin: APP, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return { status: r.status, json: await r.json().catch(() => null) };
}
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const taskContainers = (id) => docker("ps", "-q", "--filter", id ? `label=aatmiq.task=${id}` : "label=aatmiq.task").split("\n").filter(Boolean);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// The limits as the task sees them, on cgroup v2 or v1: "mem:<bytes>" and "cpu:<quota> <period>".
const LIMITS =
  'echo "mem:$(cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes)"; ' +
  'echo "cpu:$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo "$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us) $(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us)")"';
const envOf = (info, key) => info.Config.Env.find((e) => e.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";

/** Start a task with one shell command and return the command's output. */
let ws = "";
let modelId = "";
async function run(command) {
  const t = await api("POST", "/api/work/tasks", { workspaceId: ws, modelId, prompt: `run: ${command}` });
  expect(t.status === 200, `task: ${t.status} ${JSON.stringify(t.json)}`);
  const id = t.json.id;
  for (let i = 0; i < 120; i++) {
    const d = await api("GET", `/api/work/tasks/${id}`);
    const st = d.json.task.status;
    if (st === "failed") throw new Error(`task failed: ${d.json.task.error}`);
    if (st === "completed") {
      const out = d.json.events.filter((e) => e.kind === "tool_result").map((e) => e.data.text).join("\n");
      return { id, out };
    }
    await wait(1000);
  }
  throw new Error("task didn't finish");
}

await step("Setup: owner, a model (the fake one on the host) and Work AI settings", async () => {
  expect((await api("POST", "/api/setup", { orgName: "Acme", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" })).status === 200, "setup");
  ws = (await api("GET", "/api/me")).json.workspaces[0].id;
  const p = await api("POST", "/api/admin/providers", { name: "Fake", type: "openai_compatible", baseUrl: "http://host.docker.internal:11500/v1" });
  const m = await api("POST", "/api/admin/models", { providerId: p.json.id, modelKey: "qwen3:8b", displayName: "Qwen3 8B", sections: ["chat", "work"], contextLength: 32768 });
  modelId = m.json.id;
  await api("PUT", `/api/admin/workspaces/${ws}/models`, { modelIds: [modelId], defaultModelId: modelId });
  // Network commands without approval (this test is about where they can reach), and one internal host allowed.
  const s = await api("PUT", "/api/admin/work", { allowNetwork: true, browserAllowedHosts: ["host.docker.internal"] });
  expect(s.status === 200, `settings ${s.status}`);
  expect((await api("GET", "/api/admin/work")).json.isolation === "container", "not in container mode");
});

let first = "";
await step("A task runs in its own container: own user, limits, only its folder, read-only system", async () => {
  const r = await run(`id -u; ${LIMITS}; ls /data/work | wc -l; touch /etc/x 2>&1 | head -1; touch /data/x 2>/dev/null && echo data:writable || echo data:refused; echo "token:\${AATMIQ_TOKEN:+visible}"`);
  first = r.id;
  const lines = r.out.split("\n").map((l) => l.trim());
  expect(Number(lines.find((l) => /^\d{6,}$/.test(l))) >= 100000, `uid in: ${r.out}`);
  expect(r.out.includes("mem:4294967296"), `memory limit in: ${r.out}`);
  expect(r.out.includes("cpu:200000 100000"), `cpu limit in: ${r.out}`);
  expect(/^1$/m.test(r.out), `sees other task folders: ${r.out}`);
  expect(/Read-only file system/.test(r.out) && r.out.includes("data:refused"), `system writable: ${r.out}`);
  // The runtime has its token; the commands it runs don't.
  expect(/^token:$/m.test(r.out), `token visible to commands: ${r.out}`);
  const [cid] = taskContainers(r.id);
  expect(cid, "no container for the task");
  const info = JSON.parse(docker("inspect", cid))[0];
  expect(info.HostConfig.ReadonlyRootfs === true, "root not read-only");
  expect(info.HostConfig.CapDrop?.includes("ALL"), "capabilities kept");
  expect(info.HostConfig.NetworkMode === "aatmiq_tasks", `network ${info.HostConfig.NetworkMode}`);
  expect(info.HostConfig.Memory === 4294967296 && info.HostConfig.NanoCpus === 2e9, "limits");
  expect(info.Mounts.length === 1 && info.Mounts[0].Destination === `/data/work/${r.id}`, `mounts ${JSON.stringify(info.Mounts)}`);
  // The token isn't on any command line in the API container, and the proxy password isn't the token.
  const ps = docker("exec", "aatmiq-api-1", "sh", "-c", "cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' ' '");
  const token = envOf(info, "AATMIQ_TOKEN");
  expect(token.length > 20 && !ps.includes(token), "token visible in a process list");
  expect(envOf(info, "HTTPS_PROXY").startsWith("http://task:") && !envOf(info, "HTTPS_PROXY").includes(token), `proxy ${envOf(info, "HTTPS_PROXY").slice(0, 20)}`);
});

await step("Network: an allowed internal host through Aatmiq's proxy; the database refused; nothing direct", async () => {
  const r = await run(
    'curl -s -m 10 -o /dev/null -w "via-proxy:%{http_code}\\n" http://host.docker.internal:11500/v1/models; curl -s -m 10 -o /dev/null -w "db:%{http_code}\\n" http://postgres:5432/; curl -s -m 5 --noproxy "*" -o /dev/null -w "direct:%{http_code}\\n" http://host.docker.internal:11500/v1/models || echo direct:failed',
  );
  expect(r.out.includes("via-proxy:200"), `allowed host: ${r.out}`);
  expect(r.out.includes("db:403"), `database: ${r.out}`);
  expect(/direct:(000|failed)/.test(r.out), `direct: ${r.out}`);
});

await step("No internet and new limits apply to the next task; the proxy by hand doesn't help", async () => {
  await api("PUT", "/api/admin/work", { containerNetwork: "none", containerMemoryMb: 1024, containerCpus: 1 });
  const r = await run(`echo "proxies:$(env | grep -ci _proxy=)"; ${LIMITS}; curl -s -m 10 -o /dev/null -w "anon:%{http_code}\\n" -x http://aatmiq-api:3128 http://host.docker.internal:11500/v1/models`);
  expect(r.out.includes("proxies:0"), `proxy still set: ${r.out}`);
  expect(r.out.includes("mem:1073741824"), `memory: ${r.out}`);
  expect(r.out.includes("cpu:100000 100000"), `cpu: ${r.out}`);
  expect(r.out.includes("anon:407"), `proxy without a password: ${r.out}`);
  // Even with this task's own proxy password (which it isn't given), it's refused: no internet.
  const [cid] = taskContainers(r.id);
  const cred = createHmac("sha256", envOf(JSON.parse(docker("inspect", cid))[0], "AATMIQ_TOKEN")).update("aatmiq-egress").digest("hex");
  const code = docker("exec", cid, "curl", "-s", "-m", "10", "-o", "/dev/null", "-w", "%{http_code}", "-x", `http://task:${cred}@aatmiq-api:3128`, "http://host.docker.internal:11500/v1/models");
  expect(code === "403", `own password: ${code}`);
});

await step("Stopping a task removes its container", async () => {
  expect(taskContainers(first).length === 1, "first task's container not running");
  await api("POST", `/api/work/tasks/${first}/cancel`);
  for (let i = 0; i < 20 && taskContainers(first).length; i++) await wait(500);
  expect(taskContainers(first).length === 0, "container still running");
});

await step("After an API restart, leftover task containers are removed", async () => {
  expect(taskContainers().length >= 1, "no task containers to leave behind");
  docker("restart", "aatmiq-api-1");
  for (let i = 0; i < 60; i++) {
    if ((await fetch(`${APP}/api/health`).then((r) => r.status, () => 0)) === 200) break;
    await wait(1000);
  }
  for (let i = 0; i < 20 && taskContainers().length; i++) await wait(500);
  expect(taskContainers().length === 0, `left: ${taskContainers().join(",")}`);
});

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok ? "" : `\n      ${r.err}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
