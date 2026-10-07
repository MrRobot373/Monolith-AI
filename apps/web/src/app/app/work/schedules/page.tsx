"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, MoreHorizontal, Pencil, Play, Plus, Trash2, Workflow } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { TopBar } from "@/components/app/frame";
import { useSession } from "@/components/app/session";
import { useProjects } from "@/components/projects/projects";
import { StatusIcon, WorkTabs } from "@/components/work/parts";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { EmptyState, Switch } from "@/components/ui/misc";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlay";
import { Skeleton } from "@/components/ui/spinner";
import { del, get, patch, post } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import type { AvailableModel } from "@/lib/types";
import type { Schedule } from "@/lib/work";

type Freq = "daily" | "weekdays" | "weekly" | "monthly" | "hourly" | "custom";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function toCron(f: Freq, time: string, day: number, custom: string) {
  const [h, m] = time.split(":").map((x) => Number(x) || 0);
  switch (f) {
    case "daily":
      return `${m} ${h} * * *`;
    case "weekdays":
      return `${m} ${h} * * 1-5`;
    case "weekly":
      return `${m} ${h} * * ${day}`;
    case "monthly":
      return `${m} ${h} ${day} * *`;
    case "hourly":
      return `${m} * * * *`;
    default:
      return custom.trim();
  }
}

function fromCron(cron: string): { freq: Freq; time: string; day: number } {
  const p = cron.trim().split(/\s+/);
  const time = (h: string, m: string) => `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  if (p.length === 5 && /^\d+$/.test(p[0]!)) {
    const [m, h, dom, mon, dow] = p as [string, string, string, string, string];
    if (h === "*" && dom === "*" && mon === "*" && dow === "*") return { freq: "hourly", time: time("0", m), day: 1 };
    if (/^\d+$/.test(h) && mon === "*") {
      if (dom === "*" && dow === "*") return { freq: "daily", time: time(h, m), day: 1 };
      if (dom === "*" && dow === "1-5") return { freq: "weekdays", time: time(h, m), day: 1 };
      if (dom === "*" && /^\d$/.test(dow)) return { freq: "weekly", time: time(h, m), day: Number(dow) };
      if (/^\d+$/.test(dom) && dow === "*") return { freq: "monthly", time: time(h, m), day: Number(dom) };
    }
  }
  return { freq: "custom", time: "09:00", day: 1 };
}

function describeCron(cron: string): string {
  const { freq, time, day } = fromCron(cron);
  switch (freq) {
    case "daily":
      return `Every day at ${time}`;
    case "weekdays":
      return `Weekdays at ${time}`;
    case "weekly":
      return `Every ${DAYS[day]} at ${time}`;
    case "monthly":
      return `Monthly on day ${day} at ${time}`;
    case "hourly":
      return `Every hour at :${time.slice(3)}`;
    default:
      return cron;
  }
}

export default function SchedulesPage() {
  const { workspaceId } = useSession();
  const qc = useQueryClient();
  const router = useRouter();
  const schedules = useQuery({
    queryKey: ["work-schedules", workspaceId],
    queryFn: () => get<Schedule[]>(`/api/work/schedules?workspaceId=${workspaceId}`),
    enabled: !!workspaceId,
  });
  const [editing, setEditing] = useState<Schedule | "new" | null>(null);
  const [removing, setRemoving] = useState<Schedule | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["work-schedules", workspaceId] });
  const toggle = useMutation({
    mutationFn: (s: Schedule) => patch(`/api/work/schedules/${s.id}`, { enabled: !s.enabled }),
    onSuccess: refresh,
    onError: (e: Error) => toast.error(e.message),
  });
  const runNow = useMutation({
    mutationFn: (s: Schedule) => post<{ taskId: string }>(`/api/work/schedules/${s.id}/run`),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["work-tasks", workspaceId] });
      router.push(`/app/work/${r.taskId}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (s: Schedule) => del(`/api/work/schedules/${s.id}`),
    onSuccess: () => {
      refresh();
      setRemoving(null);
      toast("Schedule deleted");
    },
  });
  const list = schedules.data ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar
        icon={<Workflow />}
        title="Work AI"
        actions={
          <Button variant="primary" size="sm" onClick={() => setEditing("new")} data-testid="new-schedule">
            <Plus className="size-3.5" /> New schedule
          </Button>
        }
      />
      <WorkTabs />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8">
          <h1 className="font-serif text-[30px] leading-tight tracking-[-0.02em]">Scheduled tasks</h1>
          <p className="mt-1 max-w-xl text-[13px] text-fg-subtle">Run a task on a schedule: a morning briefing, a weekly report, a monthly clean-up. Each run is a new task you can open and follow up on.</p>
          {schedules.isLoading ? (
            <Skeleton className="mt-6 h-40 rounded-xl" />
          ) : list.length === 0 ? (
            <EmptyState
              className="mt-6 rounded-xl border border-dashed border-border"
              icon={<CalendarClock className="size-5" />}
              title="Nothing scheduled"
              description="For example: every weekday at 8:30, summarize yesterday's sales into report.md."
              action={
                <Button variant="primary" size="sm" onClick={() => setEditing("new")}>
                  <Plus className="size-3.5" /> New schedule
                </Button>
              }
            />
          ) : (
            <div className="mt-6 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
              {list.map((s) => (
                <div key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-3.5" data-testid="schedule-row">
                  <CalendarClock className="size-4 shrink-0 text-fg-subtle" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] text-fg">{s.name}</div>
                    <div className="flex flex-wrap items-center gap-x-2 text-[12px] text-fg-subtle">
                      <span>
                        {describeCron(s.cron)} ({s.timezone})
                      </span>
                      {s.projectName && <span>· in {s.projectName}</span>}
                      {s.enabled && s.nextRunAt && <span>· next {new Date(s.nextRunAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" })}</span>}
                      {s.lastTaskId && s.lastStatus && s.lastRunAt && (
                        <Link href={`/app/work/${s.lastTaskId}`} className="inline-flex items-center gap-1 hover:text-fg">
                          · <StatusIcon status={s.lastStatus} className="size-3" /> last run {timeAgo(s.lastRunAt)}
                        </Link>
                      )}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" loading={runNow.isPending && runNow.variables?.id === s.id} onClick={() => runNow.mutate(s)}>
                    <Play className="size-3.5" /> Run now
                  </Button>
                  <Switch checked={s.enabled} onCheckedChange={() => toggle.mutate(s)} label={`Enable ${s.name}`} />
                  <Menu>
                    <MenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Options for ${s.name}`}>
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </MenuTrigger>
                    <MenuContent align="end">
                      <MenuItem icon={<Pencil />} onSelect={() => setEditing(s)}>Edit</MenuItem>
                      <MenuSeparator />
                      <MenuItem icon={<Trash2 />} danger onSelect={() => setRemoving(s)}>Delete</MenuItem>
                    </MenuContent>
                  </Menu>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {editing && (
        <ScheduleDialog key={editing === "new" ? "new" : editing.id} schedule={editing === "new" ? undefined : editing} workspaceId={workspaceId} onClose={() => setEditing(null)} onSaved={refresh} />
      )}
      <Dialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Delete “${removing?.name}”?`}
        description="Tasks it already ran are kept."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => removing && remove.mutate(removing)}>Delete</Button>
          </>
        }
      />
    </div>
  );
}

function ScheduleDialog({ schedule, workspaceId, onClose, onSaved }: { schedule?: Schedule; workspaceId: string; onClose: () => void; onSaved: () => void }) {
  const initial = fromCron(schedule?.cron ?? "0 9 * * 1-5");
  const [name, setName] = useState(schedule?.name ?? "");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [freq, setFreq] = useState<Freq>(initial.freq);
  const [time, setTime] = useState(initial.time);
  const [day, setDay] = useState(initial.day);
  const [custom, setCustom] = useState(schedule?.cron ?? "0 9 * * 1-5");
  const [timezone, setTimezone] = useState(schedule?.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"));
  const [modelId, setModelId] = useState(schedule?.modelId ?? "");
  const [projectId, setProjectId] = useState(schedule?.projectId ?? "");
  const projects = useProjects(workspaceId);
  const cron = toCron(freq, time, day, custom);
  const [debounced, setDebounced] = useState(cron);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(cron), 300);
    return () => clearTimeout(t);
  }, [cron]);
  const preview = useQuery({
    queryKey: ["cron-preview", debounced, timezone],
    queryFn: () => get<{ runs: string[] }>(`/api/work/schedules/preview?cron=${encodeURIComponent(debounced)}&timezone=${encodeURIComponent(timezone)}`),
    retry: false,
  });
  const models = useQuery({
    queryKey: ["models", workspaceId, "work"],
    queryFn: () => get<AvailableModel[]>(`/api/workspaces/${workspaceId}/models?section=work`),
  });
  const save = useMutation({
    mutationFn: () => {
      const body = { name, prompt, cron, timezone, modelId: modelId || null, projectId: projectId || null };
      return schedule ? patch(`/api/work/schedules/${schedule.id}`, body) : post("/api/work/schedules", { ...body, workspaceId });
    },
    onSuccess: () => {
      onSaved();
      onClose();
      toast.success(schedule ? "Schedule saved" : "Scheduled");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={schedule ? "Edit schedule" : "New schedule"}
      className="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || !prompt.trim() || !!preview.error} loading={save.isPending} onClick={() => save.mutate()} data-testid="save-schedule">
            {schedule ? "Save" : "Schedule"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning sales brief" data-testid="schedule-name" />
        </Field>
        <Field label="Task">
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="Summarize yesterday's sales from sales.csv into report.md with a chart." data-testid="schedule-prompt" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Repeat">
            <Select value={freq} onChange={(e) => setFreq(e.target.value as Freq)} data-testid="schedule-freq">
              <option value="weekdays">Weekdays</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
              <option value="hourly">Every hour</option>
              <option value="custom">Custom (cron)</option>
            </Select>
          </Field>
          {freq === "weekly" && (
            <Field label="On">
              <Select value={day} onChange={(e) => setDay(Number(e.target.value))}>
                {DAYS.map((d, i) => (
                  <option key={d} value={i}>{d}</option>
                ))}
              </Select>
            </Field>
          )}
          {freq === "monthly" && (
            <Field label="Day">
              <Select value={day} onChange={(e) => setDay(Number(e.target.value))}>
                {Array.from({ length: 28 }, (_, i) => (
                  <option key={i} value={i + 1}>{i + 1}</option>
                ))}
              </Select>
            </Field>
          )}
          {freq === "custom" ? (
            <Field label="Cron" className="sm:col-span-2">
              <Input value={custom} onChange={(e) => setCustom(e.target.value)} className="font-mono" placeholder="30 8 * * 1-5" />
            </Field>
          ) : (
            <Field label={freq === "hourly" ? "Minute" : "At"}>
              <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Time zone">
            <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Asia/Kolkata" />
          </Field>
          <Field label="Model">
            <Select value={modelId} onChange={(e) => setModelId(e.target.value)}>
              <option value="">Workspace default</option>
              {(models.data ?? []).map((m) => (
                <option key={m.id} value={m.id}>{m.displayName}</option>
              ))}
            </Select>
          </Field>
        </div>
        {(projects.data?.length ?? 0) > 0 && (
          <Field label="Project" hint="Runs follow the project's instructions, get its files and connectors, and appear in the project.">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} data-testid="schedule-project">
              <option value="">None</option>
              {projects.data!.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </Field>
        )}
        <div className="rounded-lg border border-border bg-bg px-3 py-2.5 text-[12.5px]" data-testid="schedule-preview">
          {preview.error ? (
            <span className="text-danger">{(preview.error as Error).message}</span>
          ) : (
            <>
              <span className="text-fg-subtle">Next runs: </span>
              <span className="text-fg-muted">
                {(preview.data?.runs ?? []).map((r) => new Date(r).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })).join(" · ") || "…"}
              </span>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
