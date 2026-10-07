"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ConnectorsSection } from "@/components/admin/connectors";
import { Section } from "@/components/admin/table";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Card, Switch } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/spinner";
import { StatTile } from "@/components/admin/charts";
import { get, post, put } from "@/lib/api";
import { cn } from "@/lib/cn";

interface WorkSettings {
  approvals: "risky" | "always" | "never";
  searxngUrl: string | null;
  allowNetwork: boolean;
  maxConcurrentPerUser: number;
  idleMinutes: number;
}
interface AdminWork {
  settings: WorkSettings;
  licensed: boolean;
  stats: { running: number; queued: number; week: number };
}

const APPROVALS: { value: WorkSettings["approvals"]; title: string; desc: string }[] = [
  { value: "risky", title: "Before risky actions", desc: "Deleting files, system commands, network use, and connector tools you mark below. Recommended." },
  { value: "always", title: "Before every change", desc: "Every command, file edit and web request waits for the person who started the task." },
  { value: "never", title: "Never", desc: "The agent runs freely inside its folder. Only for trusted, sandboxed setups." },
];

export default function AdminWorkPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin-work"], queryFn: () => get<AdminWork>("/api/admin/work") });
  const [form, setForm] = useState<WorkSettings | null>(null);
  useEffect(() => {
    if (q.data && !form) setForm(q.data.settings);
  }, [q.data, form]);

  const save = useMutation({
    mutationFn: (body: Partial<WorkSettings>) => put<WorkSettings>("/api/admin/work", body),
    onSuccess: (s) => {
      setForm(s);
      void qc.invalidateQueries({ queryKey: ["admin-work"] });
      void qc.invalidateQueries({ queryKey: ["work-info"] });
      toast.success("Work AI settings saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const testSearch = useMutation({
    mutationFn: (url: string) => post<{ ok: boolean; results?: number; error?: string }>("/api/admin/work/test-search", { url }),
    onSuccess: (r) => (r.ok ? toast.success(`SearXNG works: ${r.results} results for a test search`) : toast.error(r.error ?? "Search failed")),
    onError: (e: Error) => toast.error(e.message),
  });
  if (!q.data || !form) return <Skeleton className="h-96 rounded-xl" />;
  const d = q.data;
  const dirty = JSON.stringify(form) !== JSON.stringify(d.settings);

  return (
    <div className="space-y-10">
      <PageHeader
        title="Work AI"
        description="The agent that carries out tasks: it runs commands and edits files in a private folder per task, on your servers."
        actions={
          <Button variant="primary" size="sm" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(form)} data-testid="save-work-settings">
            Save changes
          </Button>
        }
      />
      {!d.licensed && (
        <Card className="border-warning/40 p-4 text-[13px] text-warning">Work AI isn&apos;t included in your license. Settings are kept, but nobody can start tasks until it is.</Card>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Running now" value={String(d.stats.running)} />
        <StatTile label="Queued" value={String(d.stats.queued)} />
        <StatTile label="Tasks this week" value={String(d.stats.week)} />
      </div>

      <Section title="Approvals" description="When the agent stops and asks the person who started the task.">
        <div className="grid gap-3 md:grid-cols-3">
          {APPROVALS.map((a) => (
            <button
              key={a.value}
              type="button"
              onClick={() => setForm({ ...form, approvals: a.value })}
              className={cn(
                "rounded-xl border bg-surface p-4 text-left transition-colors",
                form.approvals === a.value ? "border-fg" : "border-border hover:border-border-strong",
              )}
              data-testid={`approvals-${a.value}`}
            >
              <div className="text-[13.5px] text-fg">{a.title}</div>
              <p className="mt-1 text-[12.5px] leading-snug text-fg-subtle">{a.desc}</p>
            </button>
          ))}
        </div>
      </Section>

      <Section title="Web search" description="Private search through your own SearXNG server. Queries never go to a third-party AI service.">
        <Card className="space-y-3 p-5">
          <Field label="SearXNG URL" hint="For example http://searxng:8080 in the Docker stack (profile “search”). Leave empty to turn web search off.">
            <div className="flex gap-2">
              <Input
                value={form.searxngUrl ?? ""}
                onChange={(e) => setForm({ ...form, searxngUrl: e.target.value || null })}
                placeholder="http://searxng:8080"
                data-testid="searxng-url"
              />
              <Button variant="outline" disabled={!form.searxngUrl} loading={testSearch.isPending} onClick={() => form.searxngUrl && testSearch.mutate(form.searxngUrl)}>
                Test
              </Button>
            </div>
          </Field>
        </Card>
      </Section>

      <Section title="Limits">
        <Card className="divide-y divide-border">
          <div className="flex items-start gap-4 p-5">
            <div className="min-w-0 flex-1">
              <div className="text-[13.5px] text-fg">Let commands use the network</div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-fg-subtle">
                Off: commands that download, upload or connect elsewhere (pip install, curl, git clone) need approval. Web search and connectors are separate.
              </p>
            </div>
            <Switch checked={form.allowNetwork} onCheckedChange={(v) => setForm({ ...form, allowNetwork: v })} label="Allow network" />
          </div>
          <div className="grid gap-4 p-5 sm:grid-cols-2">
            <Field label="Tasks per person at once" hint="More wait in a queue.">
              <Input type="number" min={1} max={20} value={form.maxConcurrentPerUser} onChange={(e) => setForm({ ...form, maxConcurrentPerUser: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} />
            </Field>
            <Field label="Keep a finished task ready (minutes)" hint="Follow-ups within this time are instant.">
              <Input type="number" min={1} max={240} value={form.idleMinutes} onChange={(e) => setForm({ ...form, idleMinutes: Math.max(1, Math.min(240, Number(e.target.value) || 1)) })} />
            </Field>
          </div>
        </Card>
      </Section>

      <ConnectorsSection />
    </div>
  );
}
