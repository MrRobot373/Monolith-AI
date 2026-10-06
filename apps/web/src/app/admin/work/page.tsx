"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Pencil, Plug, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Section } from "@/components/admin/table";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Badge, Card, Switch } from "@/components/ui/misc";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlay";
import { Skeleton } from "@/components/ui/spinner";
import { StatTile } from "@/components/admin/charts";
import { del, get, patch, post, put } from "@/lib/api";
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
interface Connector {
  id: string;
  name: string;
  displayName: string;
  url: string;
  approveTools: string;
  enabled: boolean;
  headerNames: string[];
}

const APPROVALS: { value: WorkSettings["approvals"]; title: string; desc: string }[] = [
  { value: "risky", title: "Before risky actions", desc: "Deleting files, system commands, network use, and connector tools you mark below. Recommended." },
  { value: "always", title: "Before every change", desc: "Every command, file edit and web request waits for the person who started the task." },
  { value: "never", title: "Never", desc: "The agent runs freely inside its folder. Only for trusted, sandboxed setups." },
];

export default function AdminWorkPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin-work"], queryFn: () => get<AdminWork>("/api/admin/work") });
  const connectors = useQuery({ queryKey: ["admin-connectors"], queryFn: () => get<Connector[]>("/api/admin/connectors") });
  const [form, setForm] = useState<WorkSettings | null>(null);
  const [editing, setEditing] = useState<Connector | "new" | null>(null);
  const [removing, setRemoving] = useState<Connector | null>(null);
  const [tools, setTools] = useState<{ connector: Connector; tools: { name: string; description?: string }[] } | null>(null);
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
  const refreshConnectors = () => qc.invalidateQueries({ queryKey: ["admin-connectors"] });
  const toggle = useMutation({
    mutationFn: (c: Connector) => patch(`/api/admin/connectors/${c.id}`, { enabled: !c.enabled }),
    onSuccess: refreshConnectors,
  });
  const test = useMutation({
    mutationFn: (c: Connector) => post<{ ok: boolean; error?: string; tools: { name: string; description?: string }[] }>(`/api/admin/connectors/${c.id}/test`),
    onSuccess: (r, c) => (r.ok ? setTools({ connector: c, tools: r.tools }) : toast.error(r.error ?? "Couldn't connect")),
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (c: Connector) => del(`/api/admin/connectors/${c.id}`),
    onSuccess: () => {
      refreshConnectors();
      setRemoving(null);
      toast("Connector removed");
    },
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

      <Section
        title="Connectors"
        description="MCP servers the agent can use as tools: your ticketing, CRM, chat or internal APIs. Credentials stay on this server."
        actions={
          <Button variant="outline" size="sm" onClick={() => setEditing("new")} data-testid="add-connector">
            <Plus className="size-3.5" /> Add connector
          </Button>
        }
      >
        {connectors.data?.length === 0 ? (
          <Card className="p-6 text-center text-[13px] text-fg-subtle">No connectors yet. Any server that speaks the Model Context Protocol over HTTP works.</Card>
        ) : (
          <Card className="divide-y divide-border">
            {(connectors.data ?? []).map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-4 px-4 py-3.5" data-testid="connector-row">
                <span className="flex size-9 items-center justify-center rounded-lg border border-border bg-bg">
                  <Plug className="size-4 text-fg-muted" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13.5px] text-fg">
                    {c.displayName} <span className="font-mono text-[11.5px] text-fg-subtle">{c.name}</span>
                    {c.headerNames.length > 0 && <Badge>Authenticated</Badge>}
                  </div>
                  <div className="truncate text-[12px] text-fg-subtle">
                    {c.url} · ask before: {c.approveTools === "*" ? "every tool" : c.approveTools || "nothing"}
                  </div>
                </div>
                <Button variant="ghost" size="sm" loading={test.isPending && test.variables?.id === c.id} onClick={() => test.mutate(c)}>
                  <Plug className="size-3.5" /> Test
                </Button>
                <Switch checked={c.enabled} onCheckedChange={() => toggle.mutate(c)} label={`Enable ${c.displayName}`} />
                <Menu>
                  <MenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Options for ${c.displayName}`}>
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </MenuTrigger>
                  <MenuContent align="end">
                    <MenuItem icon={<Pencil />} onSelect={() => setEditing(c)}>Edit</MenuItem>
                    <MenuSeparator />
                    <MenuItem icon={<Trash2 />} danger onSelect={() => setRemoving(c)}>Remove</MenuItem>
                  </MenuContent>
                </Menu>
              </div>
            ))}
          </Card>
        )}
      </Section>

      {editing && <ConnectorDialog key={editing === "new" ? "new" : editing.id} connector={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onSaved={refreshConnectors} />}
      <Dialog open={!!tools} onOpenChange={(o) => !o && setTools(null)} title={`${tools?.connector.displayName} is connected`} description={`${tools?.tools.length ?? 0} tools available to the agent.`} className="max-w-lg">
        <ul className="max-h-80 space-y-1 overflow-y-auto" data-testid="connector-tools">
          {tools?.tools.map((t) => (
            <li key={t.name} className="rounded-lg border border-border px-3 py-2">
              <div className="font-mono text-[12.5px] text-fg">{t.name}</div>
              {t.description && <div className="mt-0.5 line-clamp-2 text-[12px] text-fg-subtle">{t.description}</div>}
            </li>
          ))}
        </ul>
      </Dialog>
      <Dialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.displayName}?`}
        description="Tasks stop using its tools. Its stored credentials are deleted."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => removing && remove.mutate(removing)}>Remove</Button>
          </>
        }
      />
    </div>
  );
}

function ConnectorDialog({ connector, onClose, onSaved }: { connector?: Connector; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    displayName: connector?.displayName ?? "",
    name: connector?.name ?? "",
    url: connector?.url ?? "",
    headers: "",
    approveTools: connector?.approveTools ?? "*",
  });
  const parseHeaders = () =>
    Object.fromEntries(
      form.headers
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const i = l.indexOf(":");
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        })
        .filter(([k]) => k),
    ) as Record<string, string>;
  const save = useMutation({
    mutationFn: () => {
      const headers = form.headers.trim() ? parseHeaders() : undefined;
      return connector
        ? patch(`/api/admin/connectors/${connector.id}`, { displayName: form.displayName, url: form.url, approveTools: form.approveTools, ...(headers ? { headers } : {}) })
        : post("/api/admin/connectors", { ...form, headers });
    },
    onSuccess: () => {
      onSaved();
      onClose();
      toast.success(connector ? "Connector saved" : "Connector added. Use “Test” to see its tools.");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={connector ? `Edit ${connector.displayName}` : "Add a connector"}
      description="An MCP server reachable from this server over HTTP (streamable HTTP transport)."
      className="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!form.displayName.trim() || !form.url.trim() || (!connector && !form.name.trim())} loading={save.isPending} onClick={() => save.mutate()} data-testid="save-connector">
            {connector ? "Save" : "Add connector"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input
              autoFocus
              value={form.displayName}
              onChange={(e) => {
                const v = e.target.value;
                setForm((f) => ({ ...f, displayName: v, ...(connector ? {} : { name: v.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) }) }));
              }}
              placeholder="Jira"
              data-testid="connector-display-name"
            />
          </Field>
          <Field label="Tool prefix" hint="Lowercase; tools appear as prefix · tool.">
            <Input value={form.name} disabled={!!connector} onChange={(e) => setForm({ ...form, name: e.target.value })} className="font-mono" />
          </Field>
        </div>
        <Field label="Server URL">
          <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="http://jira-mcp:3000/mcp" data-testid="connector-url" />
        </Field>
        <Field label="Request headers" hint={connector?.headerNames.length ? `Saved: ${connector.headerNames.join(", ")}. Enter new lines to replace them, or leave empty to keep them.` : "One per line, like Authorization: Bearer …. Stored encrypted."}>
          <Textarea value={form.headers} onChange={(e) => setForm({ ...form, headers: e.target.value })} rows={2} className="font-mono text-[12px]" placeholder="Authorization: Bearer …" />
        </Field>
        <Field label="Ask before these tools" hint="Comma-separated names or patterns, like create_*, delete_*. * asks before every tool; empty never asks.">
          <Input value={form.approveTools} onChange={(e) => setForm({ ...form, approveTools: e.target.value })} className="font-mono" />
        </Field>
      </div>
    </Dialog>
  );
}
