"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  ChevronRight,
  CircleCheck,
  Circle,
  Download,
  Eye,
  FilePen,
  FileText,
  FolderOpen,
  Globe,
  ListChecks,
  Loader2,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Pin,
  PinOff,
  Plug,
  Search,
  ShieldAlert,
  Sparkles,
  Terminal,
  Trash2,
  TriangleAlert,
  Upload,
  Workflow,
  XCircle,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { TopBar, TopBarButton } from "@/components/app/frame";
import { useSession } from "@/components/app/session";
import { Markdown } from "@/components/chat/markdown";
import { FileIcon } from "@/components/documents/use-documents";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { AppLogo } from "@/components/org-logo";
import { Tooltip } from "@/components/ui/misc";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlay";
import { Skeleton } from "@/components/ui/spinner";
import { ApiError, del, formatBytes, get, patch, post, readSse } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatTokens, timeAgo } from "@/lib/format";
import { ACTIVE, describeCall, type TaskStatus, type WorkEvent, type WorkFile, type WorkTaskDetail } from "@/lib/work";
import { StatusPill, WorkComposer, type WorkComposerHandle } from "./parts";

/* ───────────── Timeline model ───────────── */

interface Step {
  callId: string;
  name: string;
  args: any;
  result?: { text: string; isError: boolean };
  approval?: Approval;
}
interface Approval {
  id: string;
  toolName: string;
  reason: string | null;
  detail: Record<string, any> | null;
  status: "pending" | "approved" | "rejected" | "expired";
}
type Item =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant"; key: string; text: string }
  | { kind: "steps"; key: string; steps: Step[] }
  | { kind: "approval"; key: string; approval: Approval }
  | { kind: "error"; key: string; text: string }
  | { kind: "stopped"; key: string };

function buildTimeline(events: WorkEvent[]) {
  const items: Item[] = [];
  const steps = new Map<string, Step>();
  const approvals = new Map<string, Approval>();
  let plan: { content: string; status: string }[] = [];
  let status: TaskStatus | null = null;
  for (const e of events) {
    const d = e.data;
    switch (e.kind) {
      case "user":
        items.push({ kind: "user", key: `u${e.seq}`, text: d.text });
        break;
      case "assistant":
        if (d.text) items.push({ kind: "assistant", key: `a${e.seq}`, text: d.text });
        break;
      case "tool_call": {
        const step: Step = { callId: d.callId, name: d.name, args: d.args };
        steps.set(d.callId, step);
        const last = items.at(-1);
        if (last?.kind === "steps") last.steps.push(step);
        else items.push({ kind: "steps", key: `s${e.seq}`, steps: [step] });
        break;
      }
      case "tool_result": {
        const step = steps.get(d.callId);
        if (step) step.result = { text: d.text, isError: d.isError };
        break;
      }
      case "approval": {
        const existing = approvals.get(d.id);
        if (existing) {
          existing.status = d.status;
          break;
        }
        const a: Approval = { id: d.id, toolName: d.toolName, reason: d.reason, detail: d.detail, status: d.status };
        approvals.set(d.id, a);
        const step = d.callId ? steps.get(d.callId) : undefined;
        if (step) step.approval = a;
        else items.push({ kind: "approval", key: `p${e.seq}`, approval: a });
        break;
      }
      case "plan":
        plan = d.items ?? [];
        break;
      case "status":
        status = d.status;
        if (d.status === "failed" && d.error) items.push({ kind: "error", key: `e${e.seq}`, text: d.error });
        if (d.status === "cancelled") items.push({ kind: "stopped", key: `c${e.seq}` });
        break;
    }
  }
  return { items, plan, status };
}

function toolIcon(name: string) {
  if (name.startsWith("mcp__")) return Plug;
  if (name === "bash" || name === "pwsh") return Terminal;
  if (name === "write" || name === "edit" || name === "str_replace_editor") return FilePen;
  if (name === "read" || name === "read_image") return FileText;
  if (name === "glob" || name === "grep") return Search;
  if (name === "web_search" || name === "web_fetch" || name.startsWith("browser_")) return Globe;
  if (name === "skill") return Sparkles;
  if (name === "todo_write") return ListChecks;
  if (name.startsWith("subagent")) return Bot;
  return ChevronRight;
}

/* ───────────── Task view ───────────── */

export function TaskView({ taskId }: { taskId: string }) {
  const { workspaceId } = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["work-task", taskId], queryFn: () => get<WorkTaskDetail>(`/api/work/tasks/${taskId}`) });
  const files = useQuery({ queryKey: ["work-files", taskId], queryFn: () => get<{ files: WorkFile[]; truncated: boolean }>(`/api/work/tasks/${taskId}/files`) });
  const [events, setEvents] = useState<WorkEvent[]>([]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState("");
  const [input, setInput] = useState("");
  const [panel, setPanel] = useState<"progress" | "files" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [preview, setPreview] = useState<WorkFile | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const afterRef = useRef(0);
  const loadedRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const composerRef = useRef<WorkComposerHandle>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  // Wide screens open the side panel by default.
  useEffect(() => {
    if (window.matchMedia("(min-width: 1280px)").matches) setPanel("progress");
  }, []);

  // Seed the timeline from the first load of this task.
  useEffect(() => {
    if (!detail.data || loadedRef.current === taskId) return;
    loadedRef.current = taskId;
    setEvents(detail.data.events);
    afterRef.current = detail.data.events.at(-1)?.seq ?? 0;
    setDraft("");
  }, [detail.data, taskId]);

  // Follow the live stream (reconnects; replays anything missed by sequence number).
  const ready = !!detail.data && loadedRef.current === taskId;
  useEffect(() => {
    if (!ready) return;
    let stopped = false;
    const ac = new AbortController();
    const refreshMeta = () => {
      void qc.invalidateQueries({ queryKey: ["work-task", taskId] });
      void qc.invalidateQueries({ queryKey: ["work-tasks", workspaceId] });
      void qc.invalidateQueries({ queryKey: ["work-approvals", workspaceId] });
    };
    (async () => {
      while (!stopped) {
        try {
          const res = await fetch(`/api/work/tasks/${taskId}/stream?after=${afterRef.current}`, { credentials: "include", signal: ac.signal });
          if (!res.ok) throw new Error(String(res.status));
          for await (const ev of readSse(res)) {
            if (ev.event === "event") {
              const e = ev.data as WorkEvent;
              if (e.seq <= afterRef.current) continue;
              afterRef.current = e.seq;
              setEvents((prev) => [...prev, e]);
              if (e.kind === "assistant" || e.kind === "tool_call") {
                setDraft("");
                setThinking("");
              }
              if (e.kind === "status" || e.kind === "approval") refreshMeta();
              if (e.kind === "tool_result") void qc.invalidateQueries({ queryKey: ["work-files", taskId] });
            } else if (ev.event === "delta") {
              setDraft((d) => d + ev.data.text);
            } else if (ev.event === "reasoning") {
              setThinking((t) => (t + ev.data.text).slice(-2000));
            } else if (ev.event === "files") {
              void qc.invalidateQueries({ queryKey: ["work-files", taskId] });
            }
          }
        } catch {
          /* reconnect below */
        }
        if (stopped) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    })();
    return () => {
      stopped = true;
      ac.abort();
    };
  }, [ready, taskId, qc, workspaceId]);

  const { items, plan, status: liveStatus } = useMemo(() => buildTimeline(events), [events]);
  const task = detail.data?.task;
  const status: TaskStatus = liveStatus ?? task?.status ?? "queued";
  const active = ACTIVE.includes(status);

  // Keep the newest step in view unless the person scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [items.length, draft, status]);

  const send = useMutation({
    mutationFn: (prompt: string) => post(`/api/work/tasks/${taskId}/messages`, { prompt }),
    onMutate: () => {
      stickRef.current = true;
      setInput("");
    },
    onError: (e: Error, prompt) => {
      setInput(prompt);
      toast.error(e instanceof ApiError && e.code === "quota_exceeded" ? "You've used your token allowance for this period." : e.message);
    },
  });
  const stop = useMutation({
    mutationFn: () => post(`/api/work/tasks/${taskId}/cancel`),
    onError: (e: Error) => toast.error(e.message),
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approve" | "reject" }) => post(`/api/work/approvals/${id}`, { decision }),
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => qc.invalidateQueries({ queryKey: ["work-approvals", workspaceId] }),
  });
  const update = useMutation({
    mutationFn: (body: { title?: string; pinned?: boolean }) => patch(`/api/work/tasks/${taskId}`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["work-task", taskId] });
      void qc.invalidateQueries({ queryKey: ["work-tasks", workspaceId] });
    },
  });
  const remove = useMutation({
    mutationFn: () => del(`/api/work/tasks/${taskId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["work-tasks", workspaceId] });
      toast("Task deleted");
      router.push("/app/work");
    },
  });
  const upload = async (list: File[]) => {
    for (const f of list) {
      const form = new FormData();
      form.append("file", f);
      const res = await fetch(`/api/work/tasks/${taskId}/files`, { method: "POST", body: form, credentials: "include" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error ?? `Couldn't add ${f.name}`);
      }
    }
    void qc.invalidateQueries({ queryKey: ["work-files", taskId] });
    toast.success(list.length === 1 ? `Added ${list[0]!.name} to the task folder` : `Added ${list.length} files to the task folder`);
    setPanel("files");
  };

  if (detail.error) {
    return (
      <div className="flex h-full flex-col">
        <TopBar icon={<Workflow />} title="Work AI" />
        <div className="flex flex-1 items-center justify-center text-[13px] text-fg-subtle">This task doesn&apos;t exist or was deleted.</div>
      </div>
    );
  }

  const fileCount = files.data?.files.length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar
        icon={<Workflow />}
        title={
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="truncate" data-testid="task-title">{task?.title ?? "Task"}</span>
            {task && <StatusPill status={status} />}
          </span>
        }
        actions={
          <>
            <TopBarButton onClick={() => setPanel((p) => (p === "files" ? null : "files"))} data-testid="files-toggle">
              <FolderOpen /> <span className="hidden sm:inline">Files</span>
              {fileCount > 0 && <span className="text-fg-subtle tabular-nums">{fileCount}</span>}
            </TopBarButton>
            <Tooltip content={panel ? "Hide panel" : "Show progress"}>
              <TopBarButton aria-label="Toggle panel" onClick={() => setPanel((p) => (p ? null : "progress"))}>
                <PanelRight />
              </TopBarButton>
            </Tooltip>
            <Menu>
              <MenuTrigger asChild>
                <TopBarButton aria-label="Task options">
                  <MoreHorizontal />
                </TopBarButton>
              </MenuTrigger>
              <MenuContent align="end" className="min-w-44">
                <MenuItem
                  icon={<Pencil />}
                  onSelect={() => {
                    setNewTitle(task?.title ?? "");
                    setRenaming(true);
                  }}
                >
                  Rename
                </MenuItem>
                <MenuItem icon={task?.pinned ? <PinOff /> : <Pin />} onSelect={() => update.mutate({ pinned: !task?.pinned })}>
                  {task?.pinned ? "Unpin" : "Pin"}
                </MenuItem>
                <MenuItem icon={<Upload />} onSelect={() => uploadRef.current?.click()}>Add files</MenuItem>
                <MenuSeparator />
                <MenuItem icon={<Trash2 />} danger onSelect={() => setConfirmDelete(true)}>Delete task</MenuItem>
              </MenuContent>
            </Menu>
          </>
        }
      />
      <input
        ref={uploadRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const list = [...(e.target.files ?? [])];
          if (list.length) void upload(list);
          e.target.value = "";
        }}
      />

      <div className="relative flex min-h-0 flex-1">
        {/* Timeline */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {!ready ? (
              <div className="mx-auto max-w-[760px] space-y-4 px-4 pt-10 sm:px-6">
                <Skeleton className="h-14 w-full rounded-xl" />
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3.5 w-1/2" />
              </div>
            ) : (
              <div className="mx-auto max-w-[760px] px-4 pt-8 pb-10 sm:px-6" data-testid="timeline">
                {items.map((it) => (
                  <TimelineItem key={it.key} item={it} active={active} onDecide={(id, decision) => decide.mutate({ id, decision })} deciding={decide.isPending ? decide.variables?.id : undefined} />
                ))}
                {active && <Working status={status} draft={draft} thinking={thinking} />}
              </div>
            )}
          </div>
          <div className="px-4 pb-3 sm:px-6">
            <div className="mx-auto max-w-[760px]">
              <WorkComposer
                ref={composerRef}
                value={input}
                onChange={setInput}
                onSubmit={() => send.mutate(input.trim())}
                placeholder={active ? "Add to the task while it works…" : "Ask for changes or a next step…"}
                busy={active}
                onStop={() => stop.mutate()}
                sending={send.isPending}
                onFiles={(list) => void upload(list)}
              />
              <div className="mt-2 flex flex-wrap justify-center gap-x-3 text-[11.5px] text-fg-subtle">
                <span>Runs in a private folder on your organization&apos;s servers.</span>
                {task && task.inputTokens + task.outputTokens > 0 && <span className="tabular-nums">{formatTokens(task.inputTokens + task.outputTokens)} tokens</span>}
              </div>
            </div>
          </div>
        </div>

        {/* Side panel */}
        <AnimatePresence initial={false}>
          {panel && (
            <motion.aside
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 12 }}
              transition={{ duration: 0.18 }}
              className="absolute inset-y-0 right-0 z-20 flex w-[min(380px,100%)] flex-col border-l border-border bg-bg shadow-soft xl:relative xl:shadow-none"
            >
              <div className="flex h-10 shrink-0 items-end gap-5 border-b border-border px-4">
                {(["progress", "files"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setPanel(t)}
                    className={cn("-mb-px border-b-2 pb-2 text-[12.5px] capitalize transition-colors", panel === t ? "border-fg text-fg" : "border-transparent text-fg-subtle hover:text-fg-muted")}
                  >
                    {t === "files" ? `Files${fileCount ? ` · ${fileCount}` : ""}` : "Progress"}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                {panel === "progress" ? (
                  <ProgressPanel plan={plan} task={task} status={status} steps={items.reduce((n, i) => n + (i.kind === "steps" ? i.steps.length : 0), 0)} />
                ) : (
                  <FilesPanel taskId={taskId} files={files.data?.files} truncated={files.data?.truncated} onPreview={setPreview} onUpload={() => uploadRef.current?.click()} />
                )}
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </div>

      <FilePreview taskId={taskId} file={preview} onClose={() => setPreview(null)} />
      <Dialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename task"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!newTitle.trim()}
              onClick={() => {
                update.mutate({ title: newTitle.trim() });
                setRenaming(false);
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <Input autoFocus value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
      </Dialog>
      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this task?"
        description="Its timeline and every file in its folder are deleted. This can't be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Delete task</Button>
          </>
        }
      />
    </div>
  );
}

/* ───────────── Timeline items ───────────── */

function TimelineItem({ item, active, onDecide, deciding }: { item: Item; active: boolean; onDecide: (id: string, d: "approve" | "reject") => void; deciding?: string }) {
  switch (item.kind) {
    case "user":
      return (
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mb-5 rounded-xl border border-border bg-surface-2 px-4 py-3 text-[14px] leading-relaxed whitespace-pre-wrap text-fg" data-testid="task-user">
          {item.text}
        </motion.div>
      );
    case "assistant":
      return (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mb-5" data-testid="task-answer">
          <div className="mb-1.5 flex items-center gap-2 text-[12.5px] text-fg-subtle">
            <AppLogo className="size-4" />
          </div>
          <div className="pl-6">
            <Markdown content={item.text} />
          </div>
        </motion.div>
      );
    case "steps":
      return (
        <div className="mb-5 space-y-0.5 pl-1" data-testid="task-steps">
          {item.steps.map((s) => (
            <StepRow key={s.callId} step={s} active={active} onDecide={onDecide} deciding={deciding} />
          ))}
        </div>
      );
    case "approval":
      return <ApprovalCard approval={item.approval} onDecide={onDecide} deciding={deciding} />;
    case "error":
      return (
        <div className="mb-5 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-[13px] text-danger" data-testid="task-error">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{item.text}</span>
        </div>
      );
    case "stopped":
      return (
        <div className="mb-5 flex items-center gap-2 text-[12.5px] text-fg-subtle">
          <XCircle className="size-3.5" /> Stopped. Send a message to continue.
        </div>
      );
  }
}

function StepRow({ step, active, onDecide, deciding }: { step: Step; active: boolean; onDecide: (id: string, d: "approve" | "reject") => void; deciding?: string }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(step.name);
  const { verb, target } = describeCall(step.name, step.args);
  const pending = !step.result && active && step.approval?.status !== "pending";
  const failed = step.result?.isError;
  return (
    <div data-testid="task-step" data-tool={step.name}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full min-w-0 items-center gap-2.5 rounded-md py-1 pr-1 text-left text-[13px] text-fg-muted transition-colors hover:text-fg"
      >
        {pending ? <Loader2 className="size-3.5 shrink-0 animate-spin text-fg-subtle" /> : <Icon className={cn("size-3.5 shrink-0", failed ? "text-danger" : "text-fg-subtle")} />}
        <span className="shrink-0">{verb}</span>
        {target && <span className="min-w-0 truncate font-mono text-[12px] text-fg-subtle">{target}</span>}
        {failed && step.approval?.status !== "rejected" && <span className="shrink-0 text-[11.5px] text-danger">failed</span>}
        <ChevronRight className={cn("ml-auto size-3.5 shrink-0 text-fg-subtle opacity-0 transition-all group-hover:opacity-100", open && "rotate-90 opacity-100")} />
      </button>
      {step.approval && (step.approval.status === "pending" ? <ApprovalCard approval={step.approval} onDecide={onDecide} deciding={deciding} /> : <ApprovalNote approval={step.approval} />)}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="my-1.5 ml-6 overflow-hidden rounded-lg border border-border bg-surface">
              <Pre label={step.name === "bash" ? "Command" : "Input"}>{step.name === "bash" ? String(step.args?.command ?? "") : JSON.stringify(step.args, null, 2)}</Pre>
              {step.result && <Pre label={step.result.isError ? "Error" : "Output"} danger={step.result.isError}>{step.result.text || "(no output)"}</Pre>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Pre({ label, children, danger }: { label: string; children: ReactNode; danger?: boolean }) {
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="px-3 pt-2 text-[11px] text-fg-subtle">{label}</div>
      <pre className={cn("max-h-72 overflow-auto px-3 pt-1 pb-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words", danger ? "text-danger" : "text-fg-muted")}>{children}</pre>
    </div>
  );
}

function ApprovalCard({ approval: a, onDecide, deciding }: { approval: Approval; onDecide: (id: string, d: "approve" | "reject") => void; deciding?: string }) {
  const { verb, target } = describeCall(a.toolName, a.detail);
  const command = a.toolName === "bash" ? String(a.detail?.command ?? "") : null;
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="my-2 ml-6 rounded-xl border border-warning/40 bg-surface p-4" data-testid="approval-card">
      <div className="flex items-center gap-2 text-[13px] text-fg">
        <ShieldAlert className="size-4 text-warning" /> Waiting for your approval
      </div>
      <p className="mt-1.5 text-[13px] text-fg-muted">
        {a.reason ?? "This action needs a person to allow it."}
        {!command && (
          <>
            {" · "}
            {verb}
            {target && <span className="font-mono text-[12px]"> {target}</span>}
          </>
        )}
      </p>
      {command ? (
        <pre className="mt-2.5 max-h-48 overflow-auto rounded-lg border border-border bg-bg px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-fg">{command}</pre>
      ) : a.detail && Object.keys(a.detail).length > 0 ? (
        <pre className="mt-2.5 max-h-48 overflow-auto rounded-lg border border-border bg-bg px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-fg-muted">{JSON.stringify(a.detail, null, 2)}</pre>
      ) : null}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" size="sm" loading={deciding === a.id} onClick={() => onDecide(a.id, "approve")} data-testid="approve">
          Approve
        </Button>
        <Button variant="outline" size="sm" disabled={deciding === a.id} onClick={() => onDecide(a.id, "reject")} data-testid="reject">
          Reject
        </Button>
      </div>
    </motion.div>
  );
}

function ApprovalNote({ approval: a }: { approval: Approval }) {
  const text = a.status === "approved" ? "Approved" : a.status === "rejected" ? "Rejected. The agent was told not to do this." : "Approval expired";
  return (
    <div className={cn("ml-6 flex items-center gap-1.5 py-0.5 text-[12px]", a.status === "approved" ? "text-fg-subtle" : "text-warning")} data-testid="approval-note">
      <ShieldAlert className="size-3" /> {text}
    </div>
  );
}

function Working({ status, draft, thinking }: { status: TaskStatus; draft: string; thinking: string }) {
  if (status === "needs_approval") return null;
  const label = status === "queued" ? "Waiting for a free slot…" : draft ? "Writing…" : thinking ? "Thinking…" : "Working…";
  return (
    <div className="mb-5">
      <div className="mb-1.5 flex items-center gap-2 text-[12.5px]">
        <AppLogo className="size-4" />
        <span className="bg-[linear-gradient(90deg,var(--fg-subtle)_0%,var(--fg)_50%,var(--fg-subtle)_100%)] bg-[length:200%_100%] bg-clip-text text-transparent animate-shimmer">
          {label}
        </span>
      </div>
      {thinking && !draft && (
        <p className="line-clamp-3 pl-6 text-[12.5px] leading-relaxed text-fg-subtle italic" data-testid="thinking">
          {thinking.slice(-400)}
        </p>
      )}
      {draft && (
        <div className="pl-6">
          <Markdown content={draft} />
        </div>
      )}
    </div>
  );
}

/* ───────────── Side panel ───────────── */

function ProgressPanel({ plan, task, status, steps }: { plan: { content: string; status: string }[]; task?: WorkTaskDetail["task"]; status: TaskStatus; steps: number }) {
  const done = plan.filter((p) => p.status === "completed").length;
  return (
    <div className="space-y-6 text-[13px]">
      <div>
        <div className="flex items-center justify-between text-[12px] text-fg-subtle">
          <span>Plan</span>
          {plan.length > 0 && <span className="tabular-nums">{done} of {plan.length}</span>}
        </div>
        {plan.length === 0 ? (
          <p className="mt-2 text-[12.5px] leading-relaxed text-fg-subtle">For longer tasks the agent writes a plan here and checks items off as it goes.</p>
        ) : (
          <ol className="mt-2 space-y-2" data-testid="plan">
            {plan.map((p, i) => (
              <li key={i} className="flex items-start gap-2">
                {p.status === "completed" ? (
                  <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
                ) : p.status === "in_progress" ? (
                  <Loader2 className={cn("mt-0.5 size-3.5 shrink-0 text-fg-subtle", ACTIVE.includes(status) && "animate-spin")} />
                ) : (
                  <Circle className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" />
                )}
                <span className={p.status === "completed" ? "text-fg-muted" : "text-fg"}>{p.content}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
      {task && (
        <div>
          <div className="text-[12px] text-fg-subtle">Details</div>
          <dl className="mt-2 divide-y divide-border rounded-lg border border-border">
            {[
              ["Status", <StatusPill key="s" status={status} />],
              ["Steps", steps],
              ["Tokens", formatTokens(task.inputTokens + task.outputTokens)],
              ["Started", timeAgo(task.createdAt)],
              ...(task.finishedAt && !ACTIVE.includes(status) ? [["Finished", timeAgo(task.finishedAt)]] : []),
            ].map(([k, v]) => (
              <div key={String(k)} className="flex items-center justify-between gap-3 px-3 py-2">
                <dt className="text-fg-subtle">{k}</dt>
                <dd className="text-fg tabular-nums">{v as ReactNode}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

function FilesPanel({ taskId, files, truncated, onPreview, onUpload }: { taskId: string; files?: WorkFile[]; truncated?: boolean; onPreview: (f: WorkFile) => void; onUpload: () => void }) {
  if (!files) return <Skeleton className="h-24 rounded-lg" />;
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-fg-subtle">Task folder</span>
        <Button variant="ghost" size="sm" onClick={onUpload}>
          <Upload className="size-3.5" /> Add
        </Button>
      </div>
      {files.length === 0 ? (
        <p className="mt-2 text-[12.5px] leading-relaxed text-fg-subtle">Files the agent creates appear here. You can also add files for it to work on.</p>
      ) : (
        <ul className="mt-1 space-y-px" data-testid="files">
          {files.map((f) => (
            <li key={f.path} className="group flex items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-surface-2">
              <FileIcon name={f.path} className="size-3.5 shrink-0" />
              <button type="button" onClick={() => onPreview(f)} className="min-w-0 flex-1 truncate text-left text-[13px] text-fg" title={f.path}>
                {f.path}
              </button>
              <span className="shrink-0 text-[11.5px] text-fg-subtle tabular-nums">{formatBytes(f.size)}</span>
              <a
                href={`/api/work/tasks/${taskId}/files/content?path=${encodeURIComponent(f.path)}&download=1`}
                aria-label={`Download ${f.path}`}
                className="rounded p-0.5 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg focus:opacity-100"
              >
                <Download className="size-3.5" />
              </a>
            </li>
          ))}
        </ul>
      )}
      {truncated && <p className="mt-2 text-[12px] text-fg-subtle">Showing the first 1,000 files.</p>}
    </div>
  );
}

const TEXT_EXT = /\.(txt|md|csv|json|log|py|js|ts|tsx|jsx|html|css|svg|ya?ml|sh|sql|xml|toml|ini|env|tsv)$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp)$/i;

function FilePreview({ taskId, file, onClose }: { taskId: string; file: WorkFile | null; onClose: () => void }) {
  const url = file ? `/api/work/tasks/${taskId}/files/content?path=${encodeURIComponent(file.path)}` : "";
  const isText = !!file && TEXT_EXT.test(file.path) && file.size < 2_000_000;
  const isImage = !!file && IMG_EXT.test(file.path);
  const text = useQuery({
    queryKey: ["work-file", taskId, file?.path, file?.modifiedAt],
    queryFn: async () => (await fetch(url, { credentials: "include" })).text(),
    enabled: isText,
  });
  return (
    <Dialog
      open={!!file}
      onOpenChange={(o) => !o && onClose()}
      title={
        <span className="flex items-center gap-2">
          <FileIcon name={file?.path ?? ""} className="size-4" /> {file?.path}
        </span>
      }
      description={file ? `${formatBytes(file.size)} · changed ${timeAgo(file.modifiedAt)}` : undefined}
      className="max-w-3xl"
      footer={
        <a href={`${url}&download=1`} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-fg">
          <Download className="size-3.5" /> Download
        </a>
      }
    >
      {isText ? (
        <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-fg" data-testid="file-preview">
          {text.data ?? "Loading…"}
        </pre>
      ) : isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={file?.path} className="max-h-[60vh] w-full rounded-lg border border-border object-contain" />
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-6 text-[13px] text-fg-subtle">
          <Eye className="size-4" /> No preview for this file type. Download it to open it.
        </div>
      )}
    </Dialog>
  );
}
