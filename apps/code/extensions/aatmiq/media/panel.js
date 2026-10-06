// Aatmiq panel webview: renders the task timeline and sends actions to the extension.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  const state = { workspace: null, reason: null, models: [], modelId: "", tasks: [], current: null, task: null, events: [], draft: "", changes: [], error: null, input: "" };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  /** A small, safe Markdown subset: code blocks, inline code, bold, italics, headings, lists, links. */
  function md(text) {
    const parts = String(text ?? "").split(/```/);
    return parts
      .map((part, i) => {
        if (i % 2 === 1) {
          const body = part.replace(/^[\w+-]*\n/, "");
          return `<pre><code>${esc(body.replace(/\n$/, ""))}</code></pre>`;
        }
        const lines = esc(part).split("\n");
        let out = "";
        let list = false;
        for (const raw of lines) {
          let l = raw
            .replace(/`([^`]+)`/g, "<code>$1</code>")
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
            .replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, "$1<em>$2</em>")
            .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="#" data-link="$2">$1</a>');
          const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(l);
          if (li) {
            if (!list) {
              out += "<ul>";
              list = true;
            }
            out += `<li>${li[1]}</li>`;
            continue;
          }
          if (list) {
            out += "</ul>";
            list = false;
          }
          const h = /^(#{1,4})\s+(.*)$/.exec(l);
          if (h) out += `<h4>${h[2]}</h4>`;
          else if (l.trim()) out += `<p>${l}</p>`;
        }
        if (list) out += "</ul>";
        return out;
      })
      .join("");
  }

  const ICONS = {
    bash: "M4 17l6-5-6-5M12 19h8",
    write: "M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z",
    edit: "M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z",
    read: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6",
    search: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3",
    web: "M12 22a10 10 0 100-20 10 10 0 000 20zM2 12h20M12 2a15 15 0 010 20M12 2a15 15 0 000 20",
    plan: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
    plug: "M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 01-4 4h-4a4 4 0 01-4-4V8z",
    step: "M9 18l6-6-6-6",
    shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  };
  const icon = (name, cls = "") => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[name] || ICONS.step}"/></svg>`;
  const toolIcon = (n) =>
    n.startsWith("mcp__") ? "plug" : n === "bash" ? "bash" : ["write", "edit", "str_replace_editor"].includes(n) ? "edit" : n === "read" ? "read" : ["glob", "grep"].includes(n) ? "search" : n.startsWith("web_") ? "web" : n === "todo_write" ? "plan" : "step";

  function describe(name, a) {
    a = a || {};
    const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
    if (mcp) return [`Used ${mcp[1]}`, mcp[2].replace(/_/g, " ")];
    switch (name) {
      case "bash":
        return ["Ran", String(a.command || "").split("\n")[0]];
      case "write":
        return ["Wrote", a.file_path || a.path];
      case "edit":
      case "str_replace_editor":
        return ["Edited", a.file_path || a.path];
      case "read":
        return ["Read", a.file_path || a.path];
      case "glob":
        return ["Looked for", a.pattern];
      case "grep":
        return ["Searched for", a.pattern];
      case "web_search":
        return ["Searched the web", (a.queries || []).join(" · ") || a.query];
      case "web_fetch":
        return ["Opened", a.url];
      case "todo_write": {
        const t = a.todos || [];
        const now = t.find((x) => x.status === "in_progress");
        return [t.length && t.every((x) => x.status === "completed") ? "Finished the plan" : now ? `Plan: ${now.content}` : `Planned ${t.length} steps`, ""];
      }
      default:
        return [`Used ${name.replace(/_/g, " ")}`, ""];
    }
  }

  function timeline() {
    const items = [];
    const steps = new Map();
    const approvals = new Map();
    let status = state.task ? state.task.status : null;
    for (const e of state.events) {
      const d = e.data || {};
      if (e.kind === "user") items.push({ kind: "user", text: d.text });
      else if (e.kind === "assistant" && d.text) items.push({ kind: "assistant", text: d.text });
      else if (e.kind === "tool_call") {
        const s = { callId: d.callId, name: d.name, args: d.args };
        steps.set(d.callId, s);
        const last = items[items.length - 1];
        if (last && last.kind === "steps") last.steps.push(s);
        else items.push({ kind: "steps", steps: [s] });
      } else if (e.kind === "tool_result") {
        const s = steps.get(d.callId);
        if (s) s.result = { text: d.text, isError: d.isError };
      } else if (e.kind === "approval") {
        const a = approvals.get(d.id);
        if (a) a.status = d.status;
        else {
          const n = { id: d.id, toolName: d.toolName, reason: d.reason, detail: d.detail, status: d.status };
          approvals.set(d.id, n);
          const s = d.callId && steps.get(d.callId);
          if (s) s.approval = n;
          else items.push({ kind: "approval", approval: n });
        }
      } else if (e.kind === "status") {
        status = d.status;
        if (d.status === "failed" && d.error) items.push({ kind: "error", text: d.error });
        if (d.status === "cancelled") items.push({ kind: "note", text: "Stopped. Send a message to continue." });
      }
    }
    return { items, status };
  }

  const active = (s) => s === "queued" || s === "running" || s === "needs_approval";

  function approvalCard(a) {
    const cmd = a.toolName === "bash" ? (a.detail && a.detail.command) || "" : "";
    const [verb, target] = describe(a.toolName, a.detail);
    if (a.status !== "pending") {
      return `<div class="note ${a.status === "approved" ? "" : "warn"}">${icon("shield")} ${a.status === "approved" ? "Approved" : a.status === "rejected" ? "Rejected" : "Expired"}</div>`;
    }
    return `<div class="approval">
      <div class="approval-title">${icon("shield")} Waiting for your approval</div>
      <div class="muted">${esc(a.reason || "This action needs your OK.")}${cmd ? "" : ` · ${esc(verb)} <code>${esc(target || "")}</code>`}</div>
      ${cmd ? `<pre><code>${esc(cmd)}</code></pre>` : ""}
      <div class="row"><button class="primary" data-decide="approve" data-id="${a.id}">Approve</button><button data-decide="reject" data-id="${a.id}">Reject</button></div>
    </div>`;
  }

  function stepRow(s, isActive) {
    const [verb, target] = describe(s.name, s.args);
    const file = ["write", "edit", "read", "str_replace_editor"].includes(s.name) ? (s.args && (s.args.file_path || s.args.path)) : null;
    const spinning = !s.result && isActive && !(s.approval && s.approval.status === "pending");
    const failed = s.result && s.result.isError;
    return `<details class="step ${failed ? "failed" : ""}">
      <summary>${spinning ? '<span class="spinner"></span>' : icon(toolIcon(s.name))}<span>${esc(verb)}</span>${target ? `<code class="target">${esc(target)}</code>` : ""}${file ? `<a href="#" class="open" data-open="${esc(file)}">Open</a>` : ""}</summary>
      <pre><code>${esc(s.name === "bash" ? (s.args && s.args.command) || "" : JSON.stringify(s.args, null, 2))}</code></pre>
      ${s.result ? `<pre class="${failed ? "err" : ""}"><code>${esc(s.result.text || "(no output)")}</code></pre>` : ""}
    </details>${s.approval ? approvalCard(s.approval) : ""}`;
  }

  function render() {
    const focused = document.activeElement && document.activeElement.id === "input";
    if (!state.workspace) {
      app.innerHTML = `<div class="empty">${state.error ? `<p class="err">${esc(state.error)}</p>` : ""}<p>${esc(state.reason || "Connecting to Aatmiq…")}</p></div>`;
      return;
    }
    const { items, status } = timeline();
    const busy = active(status);
    const options = state.tasks.map((t) => `<option value="${t.id}" ${t.id === state.current ? "selected" : ""}>${esc(t.title)}</option>`).join("");
    const body = state.task
      ? items
          .map((it) => {
            if (it.kind === "user") return `<div class="user">${esc(it.text)}</div>`;
            if (it.kind === "assistant") return `<div class="answer">${md(it.text)}</div>`;
            if (it.kind === "steps") return `<div class="steps">${it.steps.map((s) => stepRow(s, busy)).join("")}</div>`;
            if (it.kind === "approval") return approvalCard(it.approval);
            if (it.kind === "error") return `<div class="error">${esc(it.text)}</div>`;
            return `<div class="note">${esc(it.text)}</div>`;
          })
          .join("") +
        (busy && status !== "needs_approval" ? `<div class="working"><span class="shimmer">${state.draft ? "Writing…" : status === "queued" ? "Waiting for a free slot…" : "Working…"}</span>${state.draft ? `<div class="answer">${md(state.draft)}</div>` : ""}</div>` : "")
      : `<div class="hello"><div class="mark"><svg viewBox="0 0 32 32" width="26" height="26" fill="none"><rect x="1.5" y="1.5" width="29" height="29" rx="8.5" stroke="currentColor" opacity=".35"/><path d="M10 24 L16 7.5 L22 24" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16" cy="18.2" r="2.3" fill="var(--accent)"/></svg></div><h3>What should we build?</h3><p class="muted">The agent works in <strong>${esc(state.workspace.name)}</strong>: it reads code, edits files and runs commands, and asks before anything risky. Your edits and its edits show up in Source Control.</p>
         <div class="chips">${["Explain this project", "Write tests for the main module", "Find and fix a bug", "Add a README"].map((c) => `<button class="chip" data-chip="${esc(c)}">${esc(c)}</button>`).join("")}</div></div>`;
    const changes = state.changes.length
      ? `<div class="changes"><div class="changes-head"><span>${state.changes.length} changed ${state.changes.length === 1 ? "file" : "files"}</span><a href="#" data-scm>Review</a></div>${state.changes
          .slice(0, 12)
          .map((f) => `<a href="#" class="change" data-diff="${esc(f.path)}" data-status="${esc(f.status)}"><span class="st st-${esc(f.status[0])}">${esc(f.status)}</span>${esc(f.path)}</a>`)
          .join("")}</div>`
      : "";
    const models = state.models.length > 1 && !state.task ? `<select id="model">${state.models.map((m) => `<option value="${m.id}" ${m.id === state.modelId ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select>` : "";
    app.innerHTML = `
      <header><select id="tasks"><option value="">New task</option>${options}</select><button class="icon-btn" data-new title="New task">+</button></header>
      <main id="scroll">${state.error ? `<div class="error">${esc(state.error)}</div>` : ""}${body}</main>
      ${changes}
      <footer>
        <textarea id="input" rows="3" placeholder="${busy ? "Add to the task while it works…" : state.task ? "Ask for a change or a next step…" : "Describe what to build or change…"}">${esc(state.input)}</textarea>
        <div class="row">${models}<span class="grow"></span>${busy ? '<button data-stop title="Stop">Stop</button>' : ""}<button class="primary" data-send>Send</button></div>
      </footer>`;
    const scroll = document.getElementById("scroll");
    scroll.scrollTop = scroll.scrollHeight;
    if (focused) {
      const input = document.getElementById("input");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function send() {
    const text = state.input.trim();
    if (!text) return;
    state.input = "";
    state.error = null;
    vscode.postMessage({ type: "send", text, modelId: state.modelId });
    render();
  }

  app.addEventListener("input", (e) => {
    if (e.target.id === "input") state.input = e.target.value;
  });
  app.addEventListener("change", (e) => {
    if (e.target.id === "tasks") vscode.postMessage(e.target.value ? { type: "select", id: e.target.value } : { type: "new" });
    if (e.target.id === "model") state.modelId = e.target.value;
  });
  app.addEventListener("keydown", (e) => {
    if (e.target.id === "input" && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  app.addEventListener("click", (e) => {
    const t = e.target.closest("[data-send],[data-stop],[data-new],[data-decide],[data-open],[data-diff],[data-scm],[data-link],[data-chip]");
    if (!t) return;
    e.preventDefault();
    if (t.hasAttribute("data-send")) send();
    else if (t.hasAttribute("data-stop")) vscode.postMessage({ type: "stop" });
    else if (t.hasAttribute("data-new")) vscode.postMessage({ type: "new" });
    else if (t.dataset.decide) vscode.postMessage({ type: "decide", id: t.dataset.id, decision: t.dataset.decide });
    else if (t.dataset.open) vscode.postMessage({ type: "open", path: t.dataset.open });
    else if (t.dataset.diff) vscode.postMessage({ type: "diff", path: t.dataset.diff, status: t.dataset.status });
    else if (t.hasAttribute("data-scm")) vscode.postMessage({ type: "scm" });
    else if (t.dataset.link) vscode.postMessage({ type: "link", url: t.dataset.link });
    else if (t.dataset.chip) {
      state.input = t.dataset.chip;
      render();
      document.getElementById("input").focus();
    }
  });

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    switch (m.type) {
      case "context":
        state.workspace = m.workspace;
        state.reason = m.reason;
        state.models = m.models || [];
        state.modelId = (state.models.find((x) => x.isDefault) || state.models[0] || {}).id || "";
        break;
      case "tasks":
        state.tasks = m.tasks;
        break;
      case "tasks-current":
        state.current = m.current;
        break;
      case "task":
        state.task = m.task;
        state.events = m.events;
        state.current = m.task ? m.task.id : null;
        state.draft = "";
        break;
      case "event":
        state.events.push(m.event);
        if (m.event.kind === "assistant" || m.event.kind === "tool_call") state.draft = "";
        if (m.event.kind === "status" && state.task) state.task.status = m.event.data.status;
        break;
      case "delta":
        state.draft += m.text;
        break;
      case "changes":
        state.changes = m.files;
        break;
      case "prefill":
        state.input = m.text;
        break;
      case "error":
        state.error = m.message;
        break;
    }
    render();
  });

  render();
  vscode.postMessage({ type: "ready" });
})();
