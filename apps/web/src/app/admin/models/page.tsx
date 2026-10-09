"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleDashed, CircleX, Cpu, KeyRound, MoreHorizontal, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Section, Table, Td } from "@/components/admin/table";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Badge, Card, EmptyState, Switch, Tooltip } from "@/components/ui/misc";
import { Dialog, Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/overlay";
import { Spinner } from "@/components/ui/spinner";
import { del, get, patch, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatTokens, timeAgo } from "@/lib/format";
import { AutoRouting } from "@/components/admin/auto-routing";
import type { ModelTier } from "@aatmiq/shared";

interface Provider {
  id: string;
  name: string;
  type: "ollama" | "openai_compatible" | "mock";
  baseUrl: string | null;
  hasApiKey: boolean;
  health: { ok: boolean; latencyMs?: number; error?: string; checkedAt: string } | null;
  /** API keys: how many, how many usable now, and which rest after hitting a limit. */
  keys?: { total: number; available: number; resting: { index: number; until: string; reason: string | null }[] };
}
interface ModelRow {
  id: string;
  providerId: string;
  providerName: string;
  providerType: string;
  modelKey: string;
  displayName: string;
  kind: "chat" | "embedding";
  contextLength: number | null;
  vision: boolean;
  sections: string[];
  enabled: boolean;
  queryPrefix: string | null;
  documentPrefix: string | null;
  tier: ModelTier | null;
  thinkingSwitch: boolean;
}

const TYPE_LABEL: Record<Provider["type"], string> = { ollama: "Ollama", openai_compatible: "OpenAI-compatible", mock: "Demo" };
const SECTION_LABELS: Record<string, string> = { chat: "Chat", work: "Work AI", code: "Code" };

export default function ModelsPage() {
  const qc = useQueryClient();
  const providers = useQuery({ queryKey: ["admin-providers"], queryFn: () => get<Provider[]>("/api/admin/providers") });
  const models = useQuery({ queryKey: ["admin-models"], queryFn: () => get<ModelRow[]>("/api/admin/models") });
  const [addProvider, setAddProvider] = useState(false);
  const [addModelFor, setAddModelFor] = useState<Provider | null>(null);
  const [prefixesFor, setPrefixesFor] = useState<ModelRow | null>(null);
  const [keysFor, setKeysFor] = useState<Provider | null>(null);

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
    mutationFn: ({
      id,
      ...body
    }: { id: string; enabled?: boolean; sections?: string[]; vision?: boolean; queryPrefix?: string | null; documentPrefix?: string | null; tier?: ModelTier | null; thinkingSwitch?: boolean }) =>
      patch(`/api/admin/models/${id}`, body),
    onSuccess: () => {
      invalidate();
      // Tiers decide whether Auto is offered.
      qc.invalidateQueries({ queryKey: ["models"] });
    },
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
                    {p.keys && p.keys.total > 0 && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle" data-testid="provider-keys">
                        <KeyRound className="size-3.5" />
                        <span>
                          {p.keys.total} {p.keys.total === 1 ? "API key" : "API keys"}
                          {p.keys.total > 1 && ` · ${p.keys.available} ready`}
                        </span>
                        {p.keys.resting.map((r) => (
                          <Tooltip key={r.index} content={`${r.reason ?? "Limit reached"} · back ${new Date(r.until).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`}>
                            <span className="rounded border border-warning/40 px-1 text-[10.5px] text-warning">#{r.index} resting</span>
                          </Tooltip>
                        ))}
                      </div>
                    )}
                  </div>
                  <Menu>
                    <MenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="Provider actions">
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </MenuTrigger>
                    <MenuContent align="end">
                      <MenuItem icon={<RefreshCw />} onSelect={() => test.mutate(p.id)}>Test connection</MenuItem>
                      <MenuItem icon={<KeyRound />} onSelect={() => setKeysFor(p)}>Replace API keys</MenuItem>
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

      <AutoRouting models={models.data ?? []} />

      <Section title="Models" description="Turn a model off to hide it everywhere. Sections control where it can be used; the tier, where Auto uses it.">
        {models.data?.length ? (
          <Table head={["Model", "Type", "Provider", "Available in", "Auto", "Enabled", ""]}>
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
                <Td className="text-fg-muted">{m.kind === "embedding" ? "Embeddings" : "Chat"}</Td>
                <Td className="text-fg-muted">{m.providerName}</Td>
                <Td>
                  {m.kind === "embedding" ? (
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] text-fg-subtle">Document search</span>
                      <Tooltip content="Text put before searches and documents, for models trained with task prefixes (EmbeddingGemma)">
                        <button
                          onClick={() => setPrefixesFor(m)}
                          className={cn(
                            "rounded-md border px-1.5 py-0.5 text-[11.5px] transition-colors",
                            m.queryPrefix || m.documentPrefix ? "border-border-strong bg-surface-3 text-fg" : "border-border text-fg-subtle hover:text-fg-muted",
                          )}
                          data-testid="model-prefixes"
                        >
                          Task prefixes{m.queryPrefix || m.documentPrefix ? " on" : ""}
                        </button>
                      </Tooltip>
                    </div>
                  ) : (
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
                    <Tooltip content={m.vision ? "Sees images: the agent can look at pictures and screenshots" : "Text only. Turn on if this model accepts images"}>
                      <button
                        onClick={() => updateModel.mutate({ id: m.id, vision: !m.vision })}
                        className={cn(
                          "ml-1 rounded-md border px-1.5 py-0.5 text-[11.5px] transition-colors",
                          m.vision ? "border-border-strong bg-surface-3 text-fg" : "border-border text-fg-subtle hover:text-fg-muted",
                        )}
                        data-testid="model-vision"
                      >
                        Images
                      </button>
                    </Tooltip>
                    <Tooltip content={m.thinkingSwitch ? "Thinking is switched per answer: off for everyday answers, on for hard ones (with Auto)" : "Turn on for models that can switch thinking (Qwen3, Nemotron 3, Gemma 4 on vLLM or Ollama)"}>
                      <button
                        onClick={() => updateModel.mutate({ id: m.id, thinkingSwitch: !m.thinkingSwitch })}
                        className={cn(
                          "rounded-md border px-1.5 py-0.5 text-[11.5px] transition-colors",
                          m.thinkingSwitch ? "border-border-strong bg-surface-3 text-fg" : "border-border text-fg-subtle hover:text-fg-muted",
                        )}
                        data-testid="model-thinking"
                      >
                        Thinking
                      </button>
                    </Tooltip>
                  </div>
                  )}
                </Td>
                <Td>
                  {m.kind === "chat" && (
                    <Select
                      value={m.tier ?? ""}
                      onChange={(e) => updateModel.mutate({ id: m.id, tier: (e.target.value || null) as ModelTier | null })}
                      className="h-7 w-28 text-[12px]"
                      aria-label={`Auto tier for ${m.displayName}`}
                      data-testid="model-tier"
                    >
                      <option value="">Not used</option>
                      <option value="fast">Fast</option>
                      <option value="standard">Standard</option>
                      <option value="advanced">Advanced</option>
                    </Select>
                  )}
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
      {keysFor && <ProviderKeysDialog provider={keysFor} onClose={() => setKeysFor(null)} onDone={invalidate} />}
      <PrefixesDialog model={prefixesFor} onClose={() => setPrefixesFor(null)} onSave={(body) => prefixesFor && updateModel.mutate({ id: prefixesFor.id, ...body }, { onSuccess: () => setPrefixesFor(null) })} saving={updateModel.isPending} />
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
        <Field label="Base URL" hint={type === "ollama" ? "Where Ollama listens, e.g. http://gpu-box:11434, or https://ollama.com for Ollama Cloud" : "Should end in /v1, e.g. http://gpu-box:8000/v1"}>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="font-mono text-[13px]" />
        </Field>
        <ApiKeysField value={apiKey} onChange={setApiKey} />
      </div>
    </Dialog>
  );
}

/** One API key per line; Aatmiq moves to the next when one reaches its usage limit. */
function ApiKeysField({ value, onChange, hint }: { value: string; onChange: (v: string) => void; hint?: string }) {
  const count = value.split(/[\n,]+/).filter((k) => k.trim()).length;
  return (
    <Field
      label={count > 1 ? `API keys (${count})` : "API key"}
      hint={hint ?? "Optional. Stored encrypted. Several keys? One per line: when one reaches its usage limit, Aatmiq uses the next and comes back to it later."}
    >
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={count > 1 ? Math.min(6, count) : 2}
        placeholder="sk-…"
        spellCheck={false}
        autoComplete="off"
        className="font-mono text-[12px] [-webkit-text-security:disc]"
        data-testid="provider-api-keys"
      />
    </Field>
  );
}

function ProviderKeysDialog({ provider, onClose, onDone }: { provider: Provider; onClose: () => void; onDone: () => void }) {
  const [keys, setKeys] = useState("");
  const m = useMutation({
    mutationFn: () => patch(`/api/admin/providers/${provider.id}`, { apiKey: keys.trim() }),
    onSuccess: () => {
      toast.success("API keys replaced");
      onDone();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`API keys for ${provider.name}`}
      description="The saved keys are never shown. Enter the full new list; leave it empty to remove all keys."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Save keys</Button>
        </>
      }
    >
      <ApiKeysField value={keys} onChange={setKeys} hint="One per line. Aatmiq uses them in order and moves on when one reaches its limit." />
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
  const [manualKind, setManualKind] = useState<"chat" | "embedding">("chat");
  const [adding, setAdding] = useState<string | null>(null);
  const add = async (modelKey: string, kind?: "chat" | "embedding") => {
    setAdding(modelKey);
    try {
      await post("/api/admin/models", { providerId: provider.id, modelKey, displayName: prettyName(modelKey), kind: kind ?? kindFor(modelKey) });
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
              {kindFor(m.modelKey) === "embedding" && !m.added && <span className="text-[11px] text-fg-subtle">embeddings</span>}
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
            <Input
              value={manual}
              onChange={(e) => {
                setManual(e.target.value);
                setManualKind(kindFor(e.target.value));
              }}
              placeholder="e.g. deepseek-v4:32b"
              className="font-mono text-[13px]"
            />
            <select
              value={manualKind}
              onChange={(e) => setManualKind(e.target.value as "chat" | "embedding")}
              aria-label="Model type"
              className="h-9 rounded-lg border border-border bg-surface px-2 text-[13px]"
            >
              <option value="chat">Chat</option>
              <option value="embedding">Embeddings</option>
            </select>
            <Button disabled={!manual.trim()} loading={adding === manual} onClick={() => add(manual.trim(), manualKind)}>Add</Button>
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

/** Guess whether a model name is an embedding model (nomic-embed-text, bge-m3, e5, all-minilm…). */
function kindFor(key: string): "chat" | "embedding" {
  return /embed|bge|(^|[^a-z])e5([^a-z]|$)|minilm|gte-|arctic-embed|mxbai/i.test(key) ? "embedding" : "chat";
}

/** Task prefixes for an embedding model (EmbeddingGemma: "task: search result | query: " and "title: {title} | text: "). */
function PrefixesDialog({ model, onClose, onSave, saving }: { model: ModelRow | null; onClose: () => void; onSave: (b: { queryPrefix: string | null; documentPrefix: string | null }) => void; saving: boolean }) {
  const [query, setQuery] = useState("");
  const [doc, setDoc] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  if (model && shown !== model.id) {
    setShown(model.id);
    setQuery(model.queryPrefix ?? "");
    setDoc(model.documentPrefix ?? "");
  }
  return (
    <Dialog
      open={!!model}
      onOpenChange={(o) => {
        if (!o) {
          setShown(null);
          onClose();
        }
      }}
      title={`Task prefixes: ${model?.displayName ?? ""}`}
      description="Some embedding models are trained to see a short instruction before the text. Changing these applies to documents indexed from now on; re-index by picking the model again for the workspace."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => onSave({ queryPrefix: query || null, documentPrefix: doc || null })} data-testid="save-prefixes">Save</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Before searches" hint='EmbeddingGemma: "task: search result | query: "'>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} className="font-mono text-[12.5px]" data-testid="query-prefix" />
        </Field>
        <Field label="Before documents" hint='{title} becomes the document name. EmbeddingGemma: "title: {title} | text: "'>
          <Input value={doc} onChange={(e) => setDoc(e.target.value)} className="font-mono text-[12.5px]" data-testid="document-prefix" />
        </Field>
      </div>
    </Dialog>
  );
}
