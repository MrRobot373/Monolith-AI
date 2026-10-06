/**
 * Smooths over the tool-call mistakes models commonly make, so a call does what was meant instead of
 * failing on a technicality. Shared by the DSH plugin (runtime side) and tests.
 * Plain JavaScript on purpose: it is loaded directly by the harness runtime.
 *
 *  - cleanArgs:     drops a `sandbox_permissions` that doesn't ask for anything (the call's own mode,
 *                   or a value that isn't a mode), and fixes todo_write items (`task` → `content`,
 *                   missing or loosely spelled `status`)
 *  - planReminder:  a short nudge to keep the plan current, after a few steps without updating it
 */

/** What a call running in a mode may ask to widen to (mirrors DSH's escalation ladder). */
const WIDER_MODES = {
  "read-only": ["workspace-write", "danger-full-access"],
  "workspace-write": ["danger-full-access"],
};

const CONTENT_ALIASES = ["task", "title", "text", "description", "name", "step"];

const STATUS_ALIASES = {
  pending: "pending",
  todo: "pending",
  "not-started": "pending",
  not_started: "pending",
  open: "pending",
  in_progress: "in_progress",
  "in-progress": "in_progress",
  inprogress: "in_progress",
  active: "in_progress",
  doing: "in_progress",
  started: "in_progress",
  completed: "completed",
  complete: "completed",
  done: "completed",
  finished: "completed",
  skipped: "completed",
  cancelled: "completed",
  canceled: "completed",
};

/** Tags around the reminder, so the engine can keep it out of what people see. */
export const REMINDER_OPEN = "<plan-reminder>";
export const REMINDER_CLOSE = "</plan-reminder>";

/** After this many steps without a plan update, and then every REMIND_EVERY steps. */
export const REMIND_AFTER = 3;
export const REMIND_EVERY = 4;

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cleanTodo(item) {
  if (typeof item === "string") return { content: item, status: "pending" };
  if (!isRecord(item)) return item;
  const out = { ...item };
  if (typeof out.content !== "string") {
    const alias = CONTENT_ALIASES.find((k) => typeof out[k] === "string" && out[k].trim());
    if (alias) out.content = out[alias];
  }
  if (typeof out.content === "string") for (const k of CONTENT_ALIASES) delete out[k];
  const status = typeof out.status === "string" ? STATUS_ALIASES[out.status.trim().toLowerCase().replace(/\s+/g, "_")] : undefined;
  out.status = status ?? "pending";
  // Fields the tool doesn't take (ids, priorities): dropping them beats failing the whole plan.
  for (const k of Object.keys(out)) if (k !== "content" && k !== "status") delete out[k];
  return out;
}

/**
 * The arguments to run a call with. Returns the same object when nothing needed fixing.
 * @param name - the tool's name.
 * @param args - the arguments the model sent.
 * @param mode - the sandbox mode calls run in (DSH_PERMISSION_MODE).
 */
export function cleanArgs(name, args, mode) {
  if (!isRecord(args)) return args;
  let out = args;
  if (Object.hasOwn(args, "sandbox_permissions")) {
    const wanted = args.sandbox_permissions;
    const widens = typeof wanted === "string" && (WIDER_MODES[mode] ?? []).includes(wanted);
    const justified = typeof args.justification === "string" && args.justification.trim().length > 0;
    // A real request to widen goes through (DSH asks the person); anything else is dropped.
    if (!(widens && justified)) {
      out = { ...args };
      delete out.sandbox_permissions;
      delete out.justification;
    }
  }
  if (name === "todo_write") {
    let todos = out.todos ?? out.items ?? out.tasks;
    if (typeof todos === "string") {
      try {
        todos = JSON.parse(todos); // the list sent as a JSON string
      } catch {
        /* left for the tool to reject */
      }
    }
    if (Array.isArray(todos)) out = { todos: todos.map(cleanTodo) };
  }
  return out;
}

/**
 * A reminder to update the plan, or null when none is due.
 * @param todos - the plan as last written (canonical items).
 * @param since - steps taken since the plan was last written.
 */
export function planReminder(todos, since) {
  if (!Array.isArray(todos) || todos.length === 0) return null;
  const open = todos.filter((t) => t.status !== "completed");
  if (open.length === 0) return null;
  if (since < REMIND_AFTER || (since - REMIND_AFTER) % REMIND_EVERY !== 0) return null;
  const done = todos.length - open.length;
  const current = todos.find((t) => t.status === "in_progress") ?? open[0];
  return [
    REMINDER_OPEN,
    `Your plan hasn't been updated for ${since} steps: it shows ${done} of ${todos.length} done, current step "${current.content}".`,
    "If you've finished steps, mark them completed with todo_write (send the whole list) before continuing. Don't mention this reminder.",
    REMINDER_CLOSE,
  ].join("\n");
}

/** Removes plan reminders from tool output shown to people. */
export function stripReminders(text) {
  if (typeof text !== "string" || !text.includes(REMINDER_OPEN)) return text;
  return text.replace(new RegExp(`\\n*${REMINDER_OPEN}[\\s\\S]*?${REMINDER_CLOSE}\\n*`, "g"), "\n").trim();
}
