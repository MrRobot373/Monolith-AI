"use client";

import { APPROVAL_PRESETS, CATALOG_CATEGORIES, type CatalogConnector } from "@aatmiq/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Copy, ExternalLink, MoreHorizontal, Pencil, Plug, Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Section } from "@/components/admin/table";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Badge, Card, Switch } from "@/components/ui/misc";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlay";
import { del, get, patch, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { APPROVAL_LABELS, approvalPresetOf, approvalSummary, AUTH_LABELS, ConnectorIcon, type ApprovalPreset } from "@/lib/connectors";

export interface AdminConnector {
  id: string;
  name: string;
  displayName: string;
  url: string;
  catalogId: string | null;
  auth: "none" | "token" | "oauth";
  approveTools: string;
  enabled: boolean;
  headerNames: string[];
  oauthClientId: string | null;
  hasClientSecret: boolean;
  oauthClient: "admin" | "dynamic" | "metadata" | null;
  oauthScopes: string | null;
  description: string | null;
  category: string | null;
  accounts: number;
}
interface CatalogInfo {
  catalog: CatalogConnector[];
  redirectUri: string;
}
type Tool = { name: string; description?: string };

const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

/** Admin → Work AI → Connectors: what's connected, and the catalog to add more. */
export function ConnectorsSection() {
  const qc = useQueryClient();
  const connectors = useQuery({ queryKey: ["admin-connectors"], queryFn: () => get<AdminConnector[]>("/api/admin/connectors") });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AdminConnector | null>(null);
  const [removing, setRemoving] = useState<AdminConnector | null>(null);
  const [tools, setTools] = useState<{ connector: AdminConnector; tools: Tool[]; note?: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-connectors"] });
  const toggle = useMutation({ mutationFn: (c: AdminConnector) => patch(`/api/admin/connectors/${c.id}`, { enabled: !c.enabled }), onSuccess: refresh });
  const test = useMutation({
    mutationFn: (c: AdminConnector) => post<{ ok: boolean; error?: string; tools: Tool[]; note?: string }>(`/api/admin/connectors/${c.id}/test`),
    onSuccess: (r, c) => (r.ok ? setTools({ connector: c, tools: r.tools, note: r.note }) : toast.error(r.error ?? "Couldn't connect")),
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (c: AdminConnector) => del(`/api/admin/connectors/${c.id}`),
    onSuccess: () => {
      refresh();
      setRemoving(null);
      toast("Connector removed");
    },
  });

  return (
    <Section
      title="Connectors"
      description="Apps and MCP servers the agent can use as tools: email, calendars, files, CRM, design and more. Credentials stay on this server."
      actions={
        <Button variant="outline" size="sm" onClick={() => setAdding(true)} data-testid="add-connector">
          <Plus className="size-3.5" /> Add connector
        </Button>
      }
    >
      {connectors.data?.length === 0 ? (
        <Card className="p-6 text-center text-[13px] text-fg-subtle">
          No connectors yet. Add Gmail, Canva, GitHub and more from the catalog, or any server that speaks the Model Context Protocol.
        </Card>
      ) : (
        <Card className="divide-y divide-border">
          {(connectors.data ?? []).map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-4 px-4 py-3.5" data-testid="connector-row">
              <ConnectorIcon category={c.category} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[13.5px] text-fg">
                  {c.displayName} <span className="font-mono text-[11.5px] text-fg-subtle">{c.name}</span>
                  <Badge>{AUTH_LABELS[c.auth]}</Badge>
                  {c.auth === "oauth" && (
                    <span className="text-[12px] text-fg-subtle" data-testid="connector-accounts">
                      {c.accounts} {c.accounts === 1 ? "person" : "people"} connected
                    </span>
                  )}
                </div>
                <div className="truncate text-[12px] text-fg-subtle">
                  {c.url} · {approvalSummary(c.approveTools)}
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

      {adding && <AddConnectorDialog existing={connectors.data ?? []} onClose={() => setAdding(false)} onSaved={refresh} />}
      {editing && <ConnectorForm key={editing.id} connector={editing} onBack={() => setEditing(null)} onClose={() => setEditing(null)} onSaved={refresh} />}
      <Dialog
        open={!!tools}
        onOpenChange={(o) => !o && setTools(null)}
        title={tools?.note ? `${tools.connector.displayName} is ready` : `${tools?.connector.displayName} is connected`}
        description={tools?.note ?? `${tools?.tools.length ?? 0} tools available to the agent.`}
        className="max-w-lg"
      >
        {!!tools?.tools.length && (
          <ul className="max-h-80 space-y-1 overflow-y-auto" data-testid="connector-tools">
            {tools.tools.map((t) => (
              <li key={t.name} className="rounded-lg border border-border px-3 py-2">
                <div className="font-mono text-[12.5px] text-fg">{t.name}</div>
                {t.description && <div className="mt-0.5 line-clamp-2 text-[12px] text-fg-subtle">{t.description}</div>}
              </li>
            ))}
          </ul>
        )}
      </Dialog>
      <Dialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.displayName}?`}
        description="Tasks stop using its tools. Its stored credentials, and everyone's sign-ins to it, are deleted."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => removing && remove.mutate(removing)}>Remove</Button>
          </>
        }
      />
    </Section>
  );
}

/** Step 1: pick from the catalog (or a custom server). Step 2: the form. */
function AddConnectorDialog({ existing, onClose, onSaved }: { existing: AdminConnector[]; onClose: () => void; onSaved: () => void }) {
  const info = useQuery({ queryKey: ["connector-catalog"], queryFn: () => get<CatalogInfo>("/api/admin/connectors/catalog") });
  const [picked, setPicked] = useState<CatalogConnector | "custom" | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("All");
  const added = new Set(existing.map((c) => c.catalogId).filter(Boolean));
  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (info.data?.catalog ?? []).filter(
      (c) => (cat === "All" || c.category === cat) && (!term || `${c.name} ${c.description} ${c.category}`.toLowerCase().includes(term)),
    );
  }, [info.data, q, cat]);

  if (picked) {
    return (
      <ConnectorForm
        entry={picked === "custom" ? undefined : picked}
        redirectUri={info.data?.redirectUri}
        taken={new Set(existing.map((c) => c.name))}
        onBack={() => setPicked(null)}
        onClose={onClose}
        onSaved={onSaved}
      />
    );
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add a connector" description="Pick an app, or connect any MCP server." className="max-w-3xl">
      <div className="space-y-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-fg-subtle" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Gmail, Canva, GitHub…" className="pl-8" data-testid="catalog-search" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {["All", ...CATALOG_CATEGORIES].map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCat(c)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[12px] transition-colors",
                cat === c ? "border-fg text-fg" : "border-border text-fg-subtle hover:border-border-strong hover:text-fg-muted",
              )}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="grid max-h-[52vh] gap-2 overflow-y-auto sm:grid-cols-2" data-testid="catalog">
          {list.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setPicked(c)}
              className="flex items-start gap-3 rounded-xl border border-border bg-bg p-3 text-left transition-colors hover:border-border-strong"
              data-testid={`catalog-${c.id}`}
            >
              <ConnectorIcon category={c.category} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[13.5px] text-fg">
                  {c.name}
                  {added.has(c.id) && <Check className="size-3.5 text-success" aria-label="Added" />}
                </div>
                <div className="line-clamp-2 text-[12px] text-fg-subtle">{c.description}</div>
                <div className="mt-1 text-[11.5px] text-fg-subtle">
                  {c.auth === "oauth" ? (c.client === "admin" ? "Each person signs in · needs an OAuth app" : "Each person signs in") : AUTH_LABELS[c.auth]}
                </div>
              </div>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPicked("custom")}
            className="flex items-start gap-3 rounded-xl border border-dashed border-border p-3 text-left transition-colors hover:border-border-strong"
            data-testid="catalog-custom"
          >
            <ConnectorIcon />
            <div>
              <div className="text-[13.5px] text-fg">Custom server</div>
              <div className="text-[12px] text-fg-subtle">Any MCP server over HTTP: your own tools and internal APIs.</div>
            </div>
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex gap-2">
      <Input readOnly value={value} className="font-mono text-[12px]" data-testid="redirect-uri" />
      <Button
        variant="outline"
        size="icon"
        aria-label="Copy"
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
    </div>
  );
}

/** Adding (from a catalog entry or custom) or editing a connector. */
function ConnectorForm({
  connector,
  entry,
  redirectUri,
  taken,
  onBack,
  onClose,
  onSaved,
}: {
  connector?: AdminConnector;
  entry?: CatalogConnector;
  redirectUri?: string;
  taken?: Set<string>;
  onBack: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const catalog = useQuery({ queryKey: ["connector-catalog"], queryFn: () => get<CatalogInfo>("/api/admin/connectors/catalog"), enabled: !!connector });
  const source = entry ?? catalog.data?.catalog.find((c) => c.id === connector?.catalogId);
  const redirect = redirectUri ?? catalog.data?.redirectUri ?? "";
  const baseName = entry ? slug(entry.id) : "";
  const [form, setForm] = useState(() => ({
    displayName: connector?.displayName ?? entry?.name ?? "",
    name: connector?.name ?? (taken?.has(baseName) ? `${baseName}-2` : baseName),
    url: connector?.url ?? entry?.url ?? "",
    auth: connector?.auth ?? entry?.auth ?? "none",
    token: "",
    headers: "",
    clientId: connector?.oauthClientId ?? "",
    clientSecret: "",
    scopes: connector?.oauthScopes ?? "",
    preset: approvalPresetOf(connector?.approveTools ?? entry?.approveTools ?? (entry?.auth === "none" ? APPROVAL_PRESETS.none : APPROVAL_PRESETS.changes)),
    rule: connector?.approveTools ?? "",
  }));
  const needsClient = form.auth === "oauth" && source?.client === "admin";
  const custom = !source;
  const tokenHeader = source?.tokenHeader;
  const approveTools = form.preset === "custom" ? form.rule : APPROVAL_PRESETS[form.preset];

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
      const headers =
        form.auth !== "token"
          ? undefined
          : tokenHeader && form.token.trim()
            ? { [tokenHeader.name]: `${tokenHeader.prefix}${form.token.trim()}` }
            : form.headers.trim()
              ? parseHeaders()
              : undefined;
      const oauth =
        form.auth === "oauth"
          ? {
              ...(form.clientId.trim() !== (connector?.oauthClientId ?? "") || form.clientSecret ? { oauthClientId: form.clientId.trim() || null, oauthClientSecret: form.clientSecret || null } : {}),
              oauthScopes: form.scopes.trim() || null,
            }
          : {};
      const body = { displayName: form.displayName, url: form.url, auth: form.auth, approveTools, ...(headers ? { headers } : {}), ...oauth };
      return connector ? patch(`/api/admin/connectors/${connector.id}`, body) : post("/api/admin/connectors", { ...body, name: form.name, catalogId: source?.id ?? null });
    },
    onSuccess: () => {
      onSaved();
      onClose();
      toast.success(connector ? "Connector saved" : form.auth === "oauth" ? "Connector added. People connect their accounts in Work AI → Connections." : "Connector added. Use “Test” to see its tools.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const missing =
    !form.displayName.trim() ||
    !form.url.trim() ||
    (!connector && !form.name.trim()) ||
    (needsClient && !connector && (!form.clientId.trim() || !form.clientSecret)) ||
    (form.auth === "token" && !connector && !form.token.trim() && !form.headers.trim()) ||
    (form.preset === "custom" && !form.rule.trim());

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={connector ? `Edit ${connector.displayName}` : source ? `Add ${source.name}` : "Add a custom server"}
      description={source?.description ?? "An MCP server reachable from this server over HTTP (streamable HTTP transport)."}
      className="max-w-lg"
      footer={
        <>
          {!connector && (
            <Button variant="ghost" onClick={onBack} className="mr-auto">
              <ArrowLeft className="size-3.5" /> Back
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={missing} loading={save.isPending} onClick={() => save.mutate()} data-testid="save-connector">
            {connector ? "Save" : "Add connector"}
          </Button>
        </>
      }
    >
      <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input
              autoFocus={!source}
              value={form.displayName}
              onChange={(e) => {
                const v = e.target.value;
                setForm((f) => ({ ...f, displayName: v, ...(connector || source ? {} : { name: slug(v) }) }));
              }}
              placeholder="Jira"
              data-testid="connector-display-name"
            />
          </Field>
          <Field label="Tool prefix" hint="Lowercase; tools appear as prefix · tool.">
            <Input value={form.name} disabled={!!connector} onChange={(e) => setForm({ ...form, name: e.target.value })} className="font-mono" data-testid="connector-name" />
          </Field>
        </div>
        <Field label="Server URL">
          <Input value={form.url} disabled={!custom && !connector} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="http://jira-mcp:3000/mcp" data-testid="connector-url" />
        </Field>
        {custom && (
          <Field label="Sign-in">
            <Select value={form.auth} onChange={(e) => setForm({ ...form, auth: e.target.value as typeof form.auth })} data-testid="connector-auth">
              <option value="none">None (open server)</option>
              <option value="token">Shared token or headers</option>
              <option value="oauth">Each person signs in (OAuth)</option>
            </Select>
          </Field>
        )}

        {form.auth === "oauth" && (
          <div className="space-y-3 rounded-xl border border-border p-4">
            <p className="text-[12.5px] leading-relaxed text-fg-muted">
              Each person connects their own account in Work AI → Connections; the agent acts with their access only.
              {!needsClient && " Aatmiq registers itself with the service automatically, so there's nothing to set up."}
            </p>
            {(needsClient || custom || connector?.oauthClient === "admin") && (
              <>
                {source?.setup && <p className="text-[12.5px] leading-relaxed text-fg-subtle">{source.setup}</p>}
                <Field label="Redirect URI" hint="Register this exact address with the OAuth app.">
                  <CopyField value={redirect} />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={needsClient ? "Client ID" : "Client ID (optional)"}>
                    <Input value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} className="font-mono text-[12px]" data-testid="connector-client-id" />
                  </Field>
                  <Field label="Client secret" hint={connector?.hasClientSecret ? "Saved. Enter a new one to replace it." : undefined}>
                    <Input type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} className="font-mono text-[12px]" data-testid="connector-client-secret" />
                  </Field>
                </div>
              </>
            )}
            <Field label="Scopes" hint={source?.scopes ? "Leave empty for the recommended scopes." : "Optional, space-separated. Empty lets the service decide."}>
              <Input value={form.scopes} onChange={(e) => setForm({ ...form, scopes: e.target.value })} placeholder={source?.scopes ?? ""} className="font-mono text-[12px]" />
            </Field>
            {source?.docsUrl && (
              <a href={source.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12.5px] text-accent hover:underline">
                Setup guide <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        )}

        {form.auth === "token" &&
          (tokenHeader ? (
            <Field label={tokenHeader.label} hint={connector?.headerNames.length ? "Saved. Enter a new one to replace it." : source?.setup}>
              <Input type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} className="font-mono text-[12px]" data-testid="connector-token" />
            </Field>
          ) : (
            <Field label="Request headers" hint={connector?.headerNames.length ? `Saved: ${connector.headerNames.join(", ")}. Enter new lines to replace them, or leave empty to keep them.` : "One per line, like Authorization: Bearer …. Stored encrypted."}>
              <Textarea value={form.headers} onChange={(e) => setForm({ ...form, headers: e.target.value })} rows={2} className="font-mono text-[12px]" placeholder="Authorization: Bearer …" data-testid="connector-headers" />
            </Field>
          ))}

        <Field label="Approvals">
          <Select value={form.preset} onChange={(e) => setForm({ ...form, preset: e.target.value as ApprovalPreset })} data-testid="connector-approvals">
            {(Object.keys(APPROVAL_LABELS) as ApprovalPreset[]).map((p) => (
              <option key={p} value={p}>
                {APPROVAL_LABELS[p]}
              </option>
            ))}
          </Select>
        </Field>
        {form.preset === "custom" && (
          <Field label="Ask before these tools" hint="Comma-separated names or patterns, like create_*, delete_*. Prefix with ! to never ask (!get_*).">
            <Input value={form.rule} onChange={(e) => setForm({ ...form, rule: e.target.value })} className="font-mono" data-testid="connector-rule" />
          </Field>
        )}
      </div>
    </Dialog>
  );
}
