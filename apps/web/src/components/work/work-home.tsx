"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, CalendarClock, FileSearch, FileSpreadsheet, Globe, Pin, ShieldAlert, Workflow, X } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { TopBar } from "@/components/app/frame";
import { useSession } from "@/components/app/session";
import { ProjectIcon, useProject } from "@/components/projects/projects";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/spinner";
import { ApiError, get, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import type { AvailableModel } from "@/lib/types";
import { describeCall, usePendingApprovals, useWorkInfo, useWorkTasks, type WorkTaskSummary } from "@/lib/work";
import { StatusIcon, WorkComposer, WorkTabs, type StagedFile, type WorkComposerHandle } from "./parts";

const STARTERS = [
  { icon: FileSpreadsheet, label: "Analyze a spreadsheet", prompt: "Analyze the attached spreadsheet: summarize the key numbers, spot anything unusual, and save a short report as report.md." },
  { icon: Globe, label: "Research a topic", prompt: "Research the latest public information about " },
  { icon: BarChart3, label: "Make a chart", prompt: "Create a chart (PNG) from this data and explain what it shows:\n\n" },
  { icon: FileSearch, label: "Review documents", prompt: "Read the attached documents and list the decisions, open questions and deadlines in a table." },
];

export function WorkHome() {
  const { me, workspaceId } = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  const tasks = useWorkTasks(workspaceId);
  const approvals = usePendingApprovals(workspaceId);
  const info = useWorkInfo(workspaceId);
  const models = useQuery({
    queryKey: ["models", workspaceId, "work"],
    queryFn: () => get<AvailableModel[]>(`/api/workspaces/${workspaceId}/models?section=work`),
    enabled: !!workspaceId,
  });
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const composerRef = useRef<WorkComposerHandle>(null);
  // Started from a project (/app/work?project=…): the task works with its instructions, files and connectors.
  const params = useSearchParams();
  const [projectId, setProjectId] = useState<string | null>(params.get("project"));
  const project = useProject(projectId ?? undefined);
  const model = useMemo(() => {
    const list = models.data ?? [];
    return list.find((m) => m.id === modelId) ?? list.find((m) => m.isDefault) ?? list[0];
  }, [models.data, modelId]);

  const start = async () => {
    const prompt = input.trim();
    if (!prompt || sending) return;
    setSending(true);
    try {
      // With files, the task is created first, the files go into its folder, then it starts.
      const inProject = projectId && project.data ? project.data.id : undefined;
      const task = await post<{ id: string }>("/api/work/tasks", { workspaceId, prompt, modelId: model?.id, projectId: inProject, start: files.length === 0 });
      if (files.length) {
        for (const f of files) {
          const form = new FormData();
          form.append("file", f.file);
          const res = await fetch(`/api/work/tasks/${task.id}/files`, { method: "POST", body: form, credentials: "include" });
          if (!res.ok) toast.error((await res.json().catch(() => ({}))).error ?? `Couldn't add ${f.file.name}`);
        }
        const names = files.map((f) => f.file.name).join(", ");
        await post(`/api/work/tasks/${task.id}/messages`, { prompt: `${prompt}\n\n(Files in your working folder: ${names})` });
      }
      void qc.invalidateQueries({ queryKey: ["work-tasks", workspaceId] });
      if (inProject) void qc.invalidateQueries({ queryKey: ["project", inProject] });
      router.push(`/app/work/${task.id}`);
    } catch (e) {
      toast.error(e instanceof ApiError && e.code === "quota_exceeded" ? "You've used your token allowance for this period." : (e as Error).message);
      setSending(false);
    }
  };

  const firstName = me.user.name.split(" ")[0];
  const list = tasks.data ?? [];
  const noModel = models.data && models.data.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar icon={<Workflow />} title="Work AI" />
      <WorkTabs />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[760px] flex-col px-4 pt-[9vh] pb-8 sm:px-6">
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }} className="text-center">
            <h1 className="font-serif text-[36px] leading-tight tracking-[-0.02em] text-fg">What should I work on, {firstName}?</h1>
            <p className="mx-auto mt-2 max-w-md text-[13px] text-fg-subtle">
              Give {me.org.productName} a goal. It plans, runs tools in a private folder and asks you before anything risky.
            </p>
          </motion.div>
          {projectId && project.data && (
            <div className="mt-6 flex justify-center">
              <span className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-surface pr-1 pl-2.5 text-[12.5px] text-fg-muted" data-testid="task-project-chip">
                <ProjectIcon color={project.data.color} className="size-3.5" />
                In <span className="text-fg">{project.data.name}</span>: its instructions, files and connectors
                <button
                  type="button"
                  aria-label="Not in this project"
                  onClick={() => {
                    setProjectId(null);
                    router.replace("/app/work");
                  }}
                  className="ml-0.5 rounded-full p-1 text-fg-subtle hover:bg-surface-2 hover:text-fg"
                >
                  <X className="size-3" />
                </button>
              </span>
            </div>
          )}
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08, duration: 0.45 }} className={projectId && project.data ? "mt-3" : "mt-7"}>
            {noModel ? (
              <div className="rounded-xl border border-border bg-surface px-4 py-6 text-center text-[13px] text-fg-muted">
                No model is enabled for Work AI in this workspace yet. Ask your admin to enable one under Admin → Models.
              </div>
            ) : (
              <WorkComposer
                ref={composerRef}
                size="home"
                value={input}
                onChange={setInput}
                onSubmit={() => void start()}
                placeholder="Describe the task. For example: “Clean up the attached CSV and chart sales by region.”"
                sending={sending}
                files={files}
                onFiles={(l) => setFiles((f) => [...f, ...l.map((file) => ({ key: `${file.name}-${Math.random()}`, file }))])}
                onRemoveFile={(k) => setFiles((f) => f.filter((x) => x.key !== k))}
                models={models.data}
                model={model}
                onModelChange={(m) => setModelId(m.id)}
              />
            )}
          </motion.div>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {STARTERS.map((s, i) => (
              <motion.button
                key={s.label}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15 + i * 0.04 }}
                onClick={() => {
                  setInput(s.prompt);
                  composerRef.current?.focus();
                }}
                className="inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-bg px-3 text-[13px] text-fg-muted transition-colors hover:border-border-strong hover:bg-surface hover:text-fg"
              >
                <s.icon className="size-3.5" />
                {s.label}
              </motion.button>
            ))}
          </div>
          {info.data && (
            <div className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1 text-[11.5px] text-fg-subtle">
              <span>{info.data.approvals === "always" ? "Asks before every change" : info.data.approvals === "never" ? "Runs without asking" : "Asks before risky actions"}</span>
              <span>{info.data.webSearch ? "Private web search on" : "Web search off"}</span>
              <span>Up to {info.data.maxConcurrentPerUser} tasks at once</span>
            </div>
          )}
        </div>

        <div className="mx-auto w-full max-w-[760px] space-y-8 px-4 pb-12 sm:px-6">
          {(approvals.data?.length ?? 0) > 0 && (
            <section data-testid="approvals-inbox">
              <h2 className="mb-2 flex items-center gap-2 text-[13px] text-fg">
                <ShieldAlert className="size-3.5 text-warning" /> Waiting for you
              </h2>
              <div className="divide-y divide-border overflow-hidden rounded-xl border border-warning/40 bg-surface">
                {approvals.data!.map((a) => {
                  const { verb, target } = describeCall(a.toolName, a.detail);
                  return (
                    <Link key={a.id} href={`/app/work/${a.taskId}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] text-fg">{a.taskTitle}</div>
                        <div className="truncate text-[12px] text-fg-subtle">
                          {a.reason ?? "Needs approval"} · {verb} {target && <span className="font-mono">{target}</span>}
                        </div>
                      </div>
                      <Button variant="outline" size="sm">Review</Button>
                    </Link>
                  );
                })}
              </div>
            </section>
          )}

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[13px] text-fg">
                Tasks {list.length > 0 && <span className="text-fg-subtle">({list.length})</span>}
              </h2>
            </div>
            {tasks.isLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-14 rounded-xl" />
                ))}
              </div>
            ) : list.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-[13px] text-fg-subtle">Tasks you start appear here. They keep running if you close this page.</p>
            ) : (
              <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface" data-testid="task-list">
                {list.map((t) => (
                  <TaskRow key={t.id} t={t} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function TaskRow({ t }: { t: WorkTaskSummary }) {
  const sub = t.status === "failed" ? t.error : t.status === "needs_approval" ? "Waiting for your approval" : t.result;
  return (
    <Link href={`/app/work/${t.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2" data-testid="task-row">
      <StatusIcon status={t.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[13px] text-fg">
          <span className="truncate">{t.title}</span>
          {t.pinned && <Pin className="size-3 shrink-0 text-fg-subtle" />}
          {t.scheduleId && <CalendarClock className="size-3 shrink-0 text-fg-subtle" aria-label="Scheduled" />}
          {t.projectName && <span className="shrink-0 truncate rounded border border-border px-1.5 text-[11px] text-fg-subtle">{t.projectName}</span>}
        </div>
        {sub && <div className={cn("truncate text-[12px]", t.status === "failed" ? "text-danger" : "text-fg-subtle")}>{sub.replace(/[*_`#>|]+/g, "").replace(/\s+/g, " ")}</div>}
      </div>
      <span className="shrink-0 text-[11.5px] text-fg-subtle">{timeAgo(t.updatedAt)}</span>
    </Link>
  );
}
