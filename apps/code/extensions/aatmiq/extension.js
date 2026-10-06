// @ts-check
/**
 * Aatmiq panel: the organization's coding agent inside Aatmiq Code.
 *
 * Runs in the IDE's extension host (on the server, as the person's own user). It talks to the
 * Aatmiq API with the IDE's per-person token (AATMIQ_CONTROL_URL / AATMIQ_CODE_TOKEN): the agent
 * itself is Aatmiq's Work AI engine, working in this workspace folder.
 */
const vscode = require("vscode");
const { execFile } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const path = require("node:path");

const CONTROL = (process.env.AATMIQ_CONTROL_URL || "").replace(/\/$/, "");
const TOKEN = process.env.AATMIQ_CODE_TOKEN || "";

async function api(method, p, body) {
  if (!CONTROL || !TOKEN) throw new Error("The Aatmiq panel works in Aatmiq Code opened from Aatmiq.");
  const res = await fetch(`${CONTROL}${p}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Aatmiq answered ${res.status}`);
  return data;
}

/** Files changed in the workspace according to git (empty when it isn't a repository). */
function gitChanges(cwd) {
  return new Promise((resolve) => {
    execFile("git", ["status", "--porcelain", "-uall"], { cwd, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(
        stdout
          .split("\n")
          .filter(Boolean)
          .slice(0, 200)
          .map((l) => ({ status: l.slice(0, 2).trim() || "M", path: l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop() })),
      );
    });
  });
}

class AgentView {
  /** @param {vscode.ExtensionContext} ctx */
  constructor(ctx) {
    this.ctx = ctx;
    /** @type {vscode.WebviewView | undefined} */
    this.view = undefined;
    this.workspace = null;
    this.taskId = null;
    this.after = 0;
    /** @type {AbortController | null} */
    this.stream = null;
    this.pendingPrompt = null;
  }

  get folder() {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  post(msg) {
    void this.view?.webview.postMessage(msg);
  }

  /** @param {vscode.WebviewView} view */
  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = randomBytes(16).toString("base64");
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.css"));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.js"));
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource} data:; style-src ${view.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.post({ type: "error", message: e.message })));
    view.onDidDispose(() => this.stopStream());
  }

  async onMessage(m) {
    switch (m.type) {
      case "ready": {
        if (!this.folder) return this.post({ type: "context", workspace: null, reason: "Open a folder to work with the agent." });
        const c = await api("GET", `/context?folder=${encodeURIComponent(this.folder)}`);
        this.workspace = c.workspace;
        this.post({ type: "context", ...c, reason: c.workspace ? null : "This folder isn't an Aatmiq Code workspace. Open it from Code in Aatmiq." });
        if (!c.workspace) return;
        const tasks = await this.refreshTasks();
        if (this.taskId) await this.select(this.taskId);
        else if (tasks[0]) await this.select(tasks[0].id);
        if (this.pendingPrompt) {
          this.post({ type: "prefill", text: this.pendingPrompt });
          this.pendingPrompt = null;
        }
        return;
      }
      case "send": {
        if (!this.workspace) return;
        if (this.taskId) {
          await api("POST", `/tasks/${this.taskId}/messages`, { prompt: m.text });
        } else {
          const t = await api("POST", "/tasks", { codeWorkspaceId: this.workspace.id, prompt: m.text, modelId: m.modelId || undefined });
          await this.refreshTasks();
          await this.select(t.id);
        }
        return;
      }
      case "new":
        this.stopStream();
        this.taskId = null;
        this.post({ type: "task", task: null, events: [] });
        return;
      case "select":
        return this.select(m.id);
      case "stop":
        if (this.taskId) await api("POST", `/tasks/${this.taskId}/cancel`);
        return;
      case "decide":
        await api("POST", `/approvals/${m.id}`, { decision: m.decision });
        return;
      case "open": {
        if (!this.folder || !m.path) return;
        const file = path.isAbsolute(m.path) ? m.path : path.join(this.folder, m.path);
        await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
        return;
      }
      case "diff": {
        if (!this.folder) return;
        const uri = vscode.Uri.file(path.join(this.folder, m.path));
        // Last commit ↔ working copy, through the built-in Git extension; new files just open.
        try {
          const ext = vscode.extensions.getExtension("vscode.git");
          const git = (ext?.isActive ? ext.exports : await ext?.activate())?.getAPI(1);
          if (git && m.status !== "??" && m.status !== "A") {
            await vscode.commands.executeCommand("vscode.diff", git.toGitUri(uri, "HEAD"), uri, `${path.basename(m.path)} (changes)`);
            return;
          }
        } catch {
          /* fall back to opening the file */
        }
        await vscode.window.showTextDocument(uri, { preview: true });
        return;
      }
      case "scm":
        await vscode.commands.executeCommand("workbench.view.scm");
        return;
      case "link":
        if (/^https?:\/\//.test(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
        return;
    }
  }

  async refreshTasks() {
    if (!this.workspace) return [];
    const tasks = await api("GET", `/tasks?codeWorkspaceId=${this.workspace.id}`);
    this.post({ type: "tasks", tasks, current: this.taskId });
    return tasks;
  }

  async select(id) {
    this.stopStream();
    this.taskId = id;
    const d = await api("GET", `/tasks/${id}`);
    this.after = d.events.at(-1)?.seq ?? 0;
    this.post({ type: "task", task: d.task, events: d.events });
    this.post({ type: "tasks-current", current: id });
    void this.sendChanges();
    void this.follow(id);
  }

  stopStream() {
    this.stream?.abort();
    this.stream = null;
  }

  /** Follow the task's live timeline; reconnects until another task is selected. */
  async follow(id) {
    const ac = new AbortController();
    this.stream = ac;
    while (!ac.signal.aborted && this.taskId === id) {
      try {
        const res = await fetch(`${CONTROL}/tasks/${id}/stream?after=${this.after}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: ac.signal });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let event = "message";
            let data = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (!data) continue;
            const payload = JSON.parse(data);
            if (event === "event") {
              if (payload.seq <= this.after) continue;
              this.after = payload.seq;
              this.post({ type: "event", event: payload });
              if (payload.kind === "status") {
                void this.refreshTasks();
                void this.sendChanges();
              }
              if (payload.kind === "tool_result") void this.sendChanges();
            } else if (event === "delta") this.post({ type: "delta", text: payload.text });
          }
        }
      } catch {
        /* reconnect */
      }
      if (ac.signal.aborted) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  async sendChanges() {
    if (!this.folder) return;
    this.post({ type: "changes", files: await gitChanges(this.folder) });
  }

  focus(prompt) {
    if (prompt) {
      if (this.view) this.post({ type: "prefill", text: prompt });
      else this.pendingPrompt = prompt;
    }
    void vscode.commands.executeCommand("aatmiq.agent.focus");
  }
}

/** @param {vscode.ExtensionContext} ctx */
function activate(ctx) {
  const view = new AgentView(ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("aatmiq.agent", view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("aatmiq.newTask", () => {
      void view.onMessage({ type: "new" });
      view.focus();
    }),
    vscode.commands.registerCommand("aatmiq.focus", () => view.focus()),
    vscode.commands.registerCommand("aatmiq.askAboutSelection", () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return view.focus();
      const rel = view.folder ? path.relative(view.folder, ed.document.uri.fsPath) : ed.document.fileName;
      const sel = ed.selection;
      view.focus(`In ${rel} (lines ${sel.start.line + 1}-${sel.end.line + 1}):\n\n`);
    }),
  );
  // The secondary side bar otherwise opens on the built-in (disabled) Chat view: show ours.
  setTimeout(() => void vscode.commands.executeCommand("workbench.view.extension.aatmiq"), 300);
}

module.exports = { activate, deactivate() {} };
