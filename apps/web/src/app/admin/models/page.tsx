"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleDashed, CircleX, Cpu, MoreHorizontal, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Section, Table, Td } from "@/components/admin/table";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Badge, Card, EmptyState, Switch } from "@/components/ui/misc";
import { Dialog, Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/overlay";
import { Spinner } from "@/components/ui/spinner";
import { del, get, patch, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatTokens, timeAgo } from "@/lib/format";

interface Provider {
  id: string;
  name: string;
  type: "ollama" | "openai_compatible" | "mock";
  baseUrl: string | null;
  hasApiKey: boolean;
  health: { ok: boolean; latencyMs?: number; error?: string; checkedAt: string } | null;
}
interface ModelRow {
  id: string;
  providerId: string;
  providerName: string;
  providerType: string;
  modelKey: string;
  displayName: string;
  contextLength: number | null;
  sections: string[];
  enabled: boolean;
}

const TYPE_LABEL: Record<Provider["type"], string> = { ollama: "Ollama", openai_compatible: "OpenAI-compatible", mock: "Demo" };
const SECTION_LABELS: Record<string, string> = { chat: "Chat", work: "Work AI", code: "Code" };

export default function ModelsPage() {
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ["admin-providers"], queryFn: () => get<Provider[]>("/api/admin/providers") });
  const models = useQuery({ queryKey: ["admin-models"], queryFn: () => get<ModelRow[]>("/api/admin/models") });
  const [addProvider, setAddProvider] = useState(false);
  const [addModelFor, setAddModelFor] = useState<Provider | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["admin-models"] });
    qc.invalidateQueries({ queryKey: ["admin-providers"] });
    qc.invalidateQueries({ queryKey: ["models"] });
  };
  const test = useMutation({
    mutationFn: (id: string) => post<{ ok: boolean; error?: string; latencyMs: number }>(`/api/admin/providers/${id}/test`),
    onSuccess: (r) => {
      r.ok ? toast.success(`Connected in ${r.latencyMs}ms`) : toast.error(r.error ?? "Could not connect");
      invalidate();
    },
  });
  const removeProvider = useMutation({ mutationFn: (id: string) => del(`/api/admin/providers/${id}`), onSuccess: invalidate });
  const updateModel = useMutation({
    mutationFn: ({ id, ...body }: { id: string; enabled?: boolean; sections?: string[] }) => patch(`/api/admin/models/${id}`, body),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });
  const removeModel = useMutation({ mutationFn: (id: string) => del(`/api/admin/models/${id}`), onSuccess: invalidate });

  return (
    <div className="space-y-10">
      <PageHeader
        title="Models"
        description="Connect the model servers your organization runs, then choose which models each workspace can use."
        actions={
          <Button variant="primary" onClick={() => setAddProvider(true)}>
            <Plus className="size-4" /> Add provider
          </Button>
        }
      />

      <Section title="Providers" description="Servers that run models: Ollama, vLLM, LM Studio or any OpenAI-compatible endpoint.">
        {providers.data?.length === 0 ? (
          <Card>
            <EmptyState icon={<Server className="size-5" />} title="No providers yet" description="Add your Ollama or vLLM server to start using models." action={<Button variant="primary" onClick={() => setAddProvider(true)}>Add provider</Button>} />
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {providers.data?.map((p) => (
              <Card key={p.id} className="p-4">
                <div className="flex items-start gap-3">
                  <div className="flex size-9 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
                    <Server className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{p.name}</span>
                      <Badge>{TYPE_LABEL[p.type]}</Badge>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-xs text-fg-subtle">{p.baseUrl ?? "built-in"}</div>
                    <div className="mt-2 flex items-center gap-1.5 text-xs">
                      {p.health?.ok ? <CircleCheck className="size-3.5 text-success" /> : p.health ? <CircleX className="size-3.5 text-danger" /> : <CircleDashed className="size-3.5 text-fg-subtle" />}
                      <span className={p.health?.ok ? "text-fg-muted" : p.health ? "text-danger" : "text-fg-subtle"}>
                        {p.health?.ok ? `Healthy · ${p.health.latencyMs}ms` : (p.health?.error ?? "Not checked")}
                      </span>
                      {p.health?.checkedAt && <span className="text-fg-subtle">· {timeAgo(p.health.checkedAt)}</span>}
                    </div>
                  </div>
                  <Menu>
                    <MenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="Provider actions">
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </MenuTrigger>
                    <MenuContent align="end">
                      <MenuItem icon={<RefreshCw />} onSelect={() => test.mutate(p.id)}>Test connection</MenuItem>
                      <MenuItem icon={<Trash2 />} danger onSelect={() => removeProvider.mutate(p.id)}>Remove provider</MenuItem>
                    </MenuContent>
                  </Menu>
                </div>
                <Button size="sm" className="mt-4 w-full" onClick={() => setAddModelFor(p)}>
                  <Plus className="size-3.5" /> Add models from {p.name}
                </Button>
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title="Models" description="Turn a model off to hide it everywhere. Sections control where it can be used.">
        {models.data?.length ? (
          <Table head={["Model", "Provider", "Context", "Available in", "Enabled", ""]}>
            {models.data.map((m) => (
              <tr key={m.id} className="hover:bg-surface-2/50">
                <Td>
                  <div className="flex items-center gap-2.5">
                    <Cpu className="size-4 text-fg-subtle" />
                    <div>
                      <div className="font-medium">{m.displayName}</div>
                      <div className="font-mono text-[11.5px] text-fg-subtle">{m.modelKey}</div>
                    </div>
                  </div>
                </Td>
                <Td className="text-fg-muted">{m.providerName}</Td>
                <Td className="text-fg-muted tabular-nums">{m.contextLength ? formatTokens(m.contextLength) : "—"}</Td>
                <Td>
                  <div className="flex gap-1">
                    {(["chat", "work", "code"] as const).map((s) => {
                      const on = m.sections.includes(s);
                      return (
                        <button
                          key={s}
                          onClick={() => updateModel.mutate({ id: m.id, sections: on ? m.sections.filter((x) => x !== s) : [...m.sections, s] })}
                          className={cn(
                            "rounded-md border px-1.5 py-0.5 text-[11.5px] transition-colors",
                            on ? "border-border-strong bg-surface-3 text-fg" : "border-border text-fg-subtle hover:text-fg-muted",
                          )}
                        >
                          {SECTION_LABELS[s]}
                        </button>
                      );
                    })}
                  </div>
                </Td>
                <Td>
                  <Switch checked={m.enabled} onCheckedChange={(v) => updateModel.mutate({ id: m.id, enabled: v })} label={`Enable ${m.displayName}`} />
                </Td>
                <Td className="w-10 text-right">
                  <Button variant="ghost" size="icon-sm" aria-label={`Delete ${m.displayName}`} onClick={() => removeModel.mutate(m.id)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        ) : (
          <Card>
            <EmptyState icon={<Cpu className="size-5" />} title="No models yet" description="Add a provider, then pick the models it serves." />
          </Card>
        )}
      </Section>

      <AddProviderDialog open={addProvider} onOpenChange={setAddProvider} onDone={invalidate} />
      {addModelFor && <AddModelsDialog provider={addModelFor} onClose={() => setAddModelFor(null)} onDone={invalidate} />}
    </div>
  );
}

function AddProviderDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [type, setType] = useState<"ollama" | "openai_compatible">("ollama");
  const [name, setName] = useState("Ollama");
  const [baseUrl, setBaseUrl] = useState("http://localhost:11434");
  const [apiKey, setApiKey] = useState("");
  const m = useMutation({
    mutationFn: () => post<{ health: { ok: boolean; error?: string } }>("/api/admin/providers", { type, name, baseUrl, apiKey: apiKey || undefined }),
    onSuccess: (r) => {
      r.health.ok ? toast.success("Provider connected") : toast.warning("Provider added, but it isn't reachable yet", { description: r.health.error });
      onDone();
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a model provider"
      description="Aatmiq connects to it from your server. Nothing is sent to third parties."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} disabled={!name || !baseUrl} onClick={() => m.mutate()}>Connect</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Type">
          <div className="grid grid-cols-2 gap-2">
            {(["ollama", "openai_compatible"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setType(t);
                  setName(t === "ollama" ? "Ollama" : "vLLM");
                  setBaseUrl(t === "ollama" ? "http://localhost:11434" : "http://localhost:8000/v1");
                }}
                className={cn("h-16 rounded-lg border px-3 text-left transition-colors", type === t ? "border-fg-subtle bg-surface-2" : "border-border hover:border-border-strong")}
              >
                <div className="text-sm font-medium">{TYPE_LABEL[t]}</div>
                <div className="text-[11.5px] text-fg-muted">{t === "ollama" ? "Simple local serving" : "vLLM, LM Studio, TGI, APIs"}</div>
              </button>
            ))}
          </div>
        </Field>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Base URL" hint={type === "ollama" ? "Where Ollama listens, e.g. http://gpu-box:11434" : "Should end in /v1, e.g. http://gpu-box:8000/v1"}>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="font-mono text-[13px]" />
        </Field>
        <Field label="API key" hint="Optional. Stored encrypted.">
          <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
        </Field>
      </div>
    </Dialog>
  );
}

function AddModelsDialog({ provider, onClose, onDone }: { provider: Provider; onClose: () => void; onDone: () => void }) {
  const discover = useQuery({
    queryKey: ["discover", provider.id],
    queryFn: () => get<{ modelKey: string; added: boolean }[]>(`/api/admin/providers/${provider.id}/discover`),
    retry: false,
  });
  const [manual, setManual] = useState("");
  const [adding, setAdding] = useState<string | null>(null);
  const add = async (modelKey: string) => {
    setAdding(modelKey);
    try {
      await post("/api/admin/models", { providerId: provider.id, modelKey, displayName: prettyName(modelKey) });
      toast.success(`Added ${prettyName(modelKey)}`, { description: "Enable it for workspaces under Workspaces › Models." });
      discover.refetch();
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAdding(null);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Models on ${provider.name}`} description="Pick the models to make available to your organization.">
      <div className="space-y-4">
        <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
          {discover.isLoading && (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          )}
          {discover.isError && <p className="p-4 text-sm text-danger">{(discover.error as Error).message}</p>}
          {discover.data?.length === 0 && <p className="p-4 text-sm text-fg-subtle">This provider reports no models. Pull one first, e.g. <code className="font-mono">ollama pull qwen3</code>.</p>}
          {discover.data?.map((m) => (
            <div key={m.modelKey} className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-0">
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{m.modelKey}</span>
              {m.added ? (
                <Badge tone="success">Added</Badge>
              ) : (
                <Button size="sm" loading={adding === m.modelKey} onClick={() => add(m.modelKey)}>Add</Button>
              )}
            </div>
          ))}
        </div>
        <Field label="Or add by name">
          <div className="flex gap-2">
            <Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="e.g. deepseek-v4:32b" className="font-mono text-[13px]" />
            <Button disabled={!manual.trim()} loading={adding === manual} onClick={() => add(manual.trim())}>Add</Button>
          </div>
        </Field>
      </div>
    </Dialog>
  );
}

function prettyName(key: string): string {
  const base = key.split("/").pop() ?? key;
  return base
    .replace(/[:_-]+/g, " ")
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\b(\d+)b\b/gi, "$1B")
    .trim();
}
