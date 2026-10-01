"use client";

import { Button } from "@aatmiq/ui/button";
import { formatTokens, timeAgo } from "@aatmiq/ui/format";
import { Field, Input, Select, Textarea } from "@aatmiq/ui/field";
import { Badge, Card, Meter } from "@aatmiq/ui/misc";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@aatmiq/ui/overlay";
import { Skeleton } from "@aatmiq/ui/spinner";
import { Section, Table, Td } from "@aatmiq/ui/table";
import { FEATURES, SECTIONS, TIERS, type Feature, type Tier } from "@aatmiq/license";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Check, Copy, KeyRound, MoreHorizontal, Pencil, Plus, RotateCcw, ServerCog, Trash2, TriangleAlert } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell";
import { del, get, patch, post } from "@/lib/api";
import type { CustomerDetail, LicenseRow } from "@/lib/types";

const SECTION_LABEL: Record<string, string> = { chat: "Chat", work: "Work AI", code: "Code" };
const fmt = (d: string) => new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export default function CustomerPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["customer", id], queryFn: () => get<CustomerDetail>(`/api/customers/${id}`) });
  const [licDialog, setLicDialog] = useState<{ license?: LicenseRow } | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<LicenseRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["customer", id] });
    qc.invalidateQueries({ queryKey: ["customers"] });
    qc.invalidateQueries({ queryKey: ["overview"] });
  };
  const onError = (e: Error) => toast.error(e.message);
  const action = useMutation({
    mutationFn: ({ l, what }: { l: LicenseRow; what: "revoke" | "restore" | "reset-instance" }) => post(`/api/licenses/${l.id}/${what}`),
    onSuccess: (_d, v) => {
      refresh();
      setConfirmRevoke(null);
      toast(v.what === "revoke" ? "License revoked. The deployment stops at its next check-in." : v.what === "restore" ? "License restored" : "Installation binding cleared");
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => del(`/api/customers/${id}`),
    onSuccess: () => {
      refresh();
      router.push("/customers");
    },
    onError,
  });

  if (!q.data) return <Skeleton className="h-96 rounded-xl" />;
  const c = q.data;
  const copyKey = (l: LicenseRow) => {
    void navigator.clipboard.writeText(l.token);
    toast.success("License key copied");
  };

  return (
    <div className="space-y-10">
      <PageHeader
        title={<span data-testid="customer-name">{c.name}</span>}
        description={
          <>
            {c.contactEmail ?? "No contact"} · customer since {fmt(c.createdAt)}
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" /> Edit
            </Button>
            <Button variant="primary" size="sm" onClick={() => setLicDialog({})}>
              <Plus className="size-3.5" /> Issue license
            </Button>
          </>
        }
      />
      {c.notes && <Card className="p-4 text-[13px] whitespace-pre-wrap text-fg-muted">{c.notes}</Card>}

      <Section title="Licenses">
        {c.licenses.length === 0 ? (
          <Card className="flex flex-col items-center gap-2 px-6 py-10 text-center">
            <KeyRound className="size-5 text-fg-subtle" />
            <div className="text-[14px] text-fg">No license yet</div>
            <p className="text-[12.5px] text-fg-subtle">Issue one, then send the key to the customer. They paste it during setup or in Admin → License.</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {c.licenses.map((l) => {
              const expired = new Date(l.expiresAt) < new Date();
              const used = l.activeSeats ?? 0;
              return (
                <Card key={l.id} className="p-5" data-testid="license-card">
                  <div className="flex flex-wrap items-start gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[15px] text-fg">{TIERS[l.tier as Tier]?.label ?? l.tier} plan</span>
                        {l.status === "revoked" ? <Badge tone="danger">Revoked</Badge> : expired ? <Badge tone="warning">Expired</Badge> : <Badge tone="success">Active</Badge>}
                        {l.modelMode === "managed" && <Badge>Managed models</Badge>}
                      </div>
                      <div className="mt-1 text-[12.5px] text-fg-subtle">
                        Valid until {fmt(l.expiresAt)} · issued {fmt(l.issuedAt)} · <code className="font-mono">{l.id.slice(0, 8)}</code>
                      </div>
                    </div>
                    <div className="w-48">
                      <div className="flex justify-between text-[12.5px]">
                        <span className="text-fg-subtle">Seats</span>
                        <span className="tabular-nums" data-testid="license-seats">
                          {used} / {l.seats}
                        </span>
                      </div>
                      <Meter className="mt-1.5" value={used / Math.max(1, l.seats)} />
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="outline" size="sm" onClick={() => copyKey(l)} data-testid="copy-key">
                        <Copy className="size-3.5" /> Copy key
                      </Button>
                      <Menu>
                        <MenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label="License options">
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </MenuTrigger>
                        <MenuContent align="end">
                          <MenuItem icon={<Pencil />} onSelect={() => setLicDialog({ license: l })}>Change terms</MenuItem>
                          {l.instanceId && <MenuItem icon={<ServerCog />} onSelect={() => action.mutate({ l, what: "reset-instance" })}>Reset installation</MenuItem>}
                          <MenuSeparator />
                          {l.status === "active" ? (
                            <MenuItem icon={<Ban />} danger onSelect={() => setConfirmRevoke(l)}>Revoke</MenuItem>
                          ) : (
                            <MenuItem icon={<RotateCcw />} onSelect={() => action.mutate({ l, what: "restore" })}>Restore</MenuItem>
                          )}
                        </MenuContent>
                      </Menu>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-4 border-t border-border pt-4 text-[12.5px] sm:grid-cols-4">
                    <div>
                      <div className="text-fg-subtle">Sections</div>
                      <div className="mt-1 text-fg">{l.sections.map((s) => SECTION_LABEL[s] ?? s).join(", ")}</div>
                    </div>
                    <div>
                      <div className="text-fg-subtle">Features</div>
                      <div className="mt-1 text-fg">{l.features.length ? l.features.map((f) => FEATURES[f as Feature] ?? f).join(", ") : "None"}</div>
                    </div>
                    <div>
                      <div className="text-fg-subtle">Last check-in</div>
                      <div className="mt-1 text-fg" data-testid="license-last-check-in">
                        {l.lastCheckInAt ? `${timeAgo(l.lastCheckInAt)}${l.lastVersion ? ` · v${l.lastVersion}` : ""}` : "Never"}
                      </div>
                    </div>
                    <div>
                      <div className="text-fg-subtle">Installation</div>
                      <div className="mt-1 truncate font-mono text-fg">{l.instanceId ?? "Not installed yet"}</div>
                    </div>
                  </div>
                  {l.instanceConflict && (
                    <div className="mt-3 flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">
                      <TriangleAlert className="size-3.5 shrink-0" /> This key has checked in from more than one installation. If the customer moved servers, reset the installation.
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Recent check-ins" description="What deployments report: seats in use, version and token totals. Never content.">
        <Table head={["When", "Version", "Seats in use", "Tokens", "Installation"]}>
          {c.checkIns.map((ci) => (
            <tr key={ci.id}>
              <Td className="text-fg-muted">{timeAgo(ci.createdAt)}</Td>
              <Td>{ci.version ?? "—"}</Td>
              <Td className="tabular-nums">{ci.activeSeats}</Td>
              <Td className="tabular-nums">{formatTokens(ci.usage.reduce((n, u) => n + u.inputTokens + u.outputTokens, 0))}</Td>
              <Td className="font-mono text-[12px] text-fg-subtle">{ci.instanceId.slice(0, 13)}…</Td>
            </tr>
          ))}
          {c.checkIns.length === 0 && (
            <tr>
              <Td className="py-8 text-center text-fg-subtle">No check-ins yet.</Td>
            </tr>
          )}
        </Table>
      </Section>

      <Section title="Danger zone">
        <Card className="flex items-center gap-3 p-4">
          <div className="flex-1 text-[13px] text-fg-muted">Delete this customer and its license history. Revoke active licenses first.</div>
          <Button variant="outline" size="sm" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="size-3.5" /> Delete customer
          </Button>
        </Card>
      </Section>

      {licDialog && <LicenseDialog customerId={c.id} license={licDialog.license} onClose={() => setLicDialog(null)} onSaved={refresh} />}
      {editing && <CustomerDialog customer={c} onClose={() => setEditing(false)} onSaved={refresh} />}
      <Dialog
        open={!!confirmRevoke}
        onOpenChange={(o) => !o && setConfirmRevoke(null)}
        title="Revoke this license?"
        description="At its next check-in the deployment stops working (people can still read their history). You can restore it later."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRevoke(null)}>Cancel</Button>
            <Button variant="danger" loading={action.isPending} onClick={() => confirmRevoke && action.mutate({ l: confirmRevoke, what: "revoke" })}>Revoke license</Button>
          </>
        }
      />
      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${c.name}?`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Delete</Button>
          </>
        }
      />
    </div>
  );
}

function yearFromNow() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

function LicenseDialog({ customerId, license, onClose, onSaved }: { customerId: string; license?: LicenseRow; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    tier: (license?.tier ?? "work") as Tier,
    seats: String(license?.seats ?? 10),
    expiresAt: license ? license.expiresAt.slice(0, 10) : yearFromNow(),
    modelMode: license?.modelMode ?? "self",
    accent: license?.accent ?? "",
    features: (license?.features ?? [...TIERS.work.features]) as Feature[],
    sections: license?.sections ?? [...TIERS.work.sections],
  });
  const preset = TIERS[form.tier];
  const save = useMutation({
    mutationFn: () => {
      const body = {
        tier: form.tier,
        seats: Number(form.seats),
        expiresAt: new Date(`${form.expiresAt}T23:59:59Z`).toISOString(),
        modelMode: form.modelMode,
        accent: form.accent || null,
        features: form.features,
        sections: form.sections,
      };
      return license ? patch(`/api/licenses/${license.id}`, body) : post(`/api/customers/${customerId}/licenses`, body);
    },
    onSuccess: () => {
      onSaved();
      onClose();
      toast.success(license ? "Terms updated. The deployment gets the new key at its next check-in." : "License issued. Copy the key and send it to the customer.");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const toggle = <T extends string>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={license ? "Change license terms" : "Issue a license"}
      description={license ? "The key is re-signed with the new terms." : "Signed with the license server's key and verified offline by the customer's server."}
      className="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!Number(form.seats) || !form.sections.length} loading={save.isPending} onClick={() => save.mutate()}>
            {license ? "Save" : "Issue license"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Plan">
            <Select
              value={form.tier}
              onChange={(e) => {
                const tier = e.target.value as Tier;
                setForm((f) => ({ ...f, tier, features: [...TIERS[tier].features], sections: [...TIERS[tier].sections] }));
              }}
              data-testid="license-tier"
            >
              {(Object.keys(TIERS) as Tier[]).map((t) => (
                <option key={t} value={t}>
                  {TIERS[t].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Seats">
            <Input type="number" min={1} value={form.seats} onChange={(e) => setForm((f) => ({ ...f, seats: e.target.value }))} data-testid="license-seats-input" />
          </Field>
          <Field label="Valid until">
            <Input type="date" value={form.expiresAt} onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))} />
          </Field>
          <Field label="Models">
            <Select value={form.modelMode} onChange={(e) => setForm((f) => ({ ...f, modelMode: e.target.value as "self" | "managed" }))}>
              <option value="self">Managed by customer</option>
              <option value="managed">Managed by Aatmiq</option>
            </Select>
          </Field>
        </div>
        <Field label="Sections">
          <div className="flex flex-wrap gap-2">
            {SECTIONS.map((s) => (
              <Chip key={s} on={form.sections.includes(s)} onClick={() => setForm((f) => ({ ...f, sections: toggle(f.sections, s) }))}>
                {SECTION_LABEL[s]}
              </Chip>
            ))}
          </div>
        </Field>
        <Field label="Features" hint={`${preset.label} includes ${preset.features.map((f) => FEATURES[f]).join(", ") || "none"} by default.`}>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(FEATURES) as Feature[]).map((f) => (
              <Chip key={f} on={form.features.includes(f)} onClick={() => setForm((x) => ({ ...x, features: toggle(x.features, f) }))}>
                {FEATURES[f]}
              </Chip>
            ))}
          </div>
        </Field>
        <Field label="Default accent" hint="Optional. Pre-fills the customer's branding at setup, e.g. #22D3EE.">
          <Input value={form.accent} onChange={(e) => setForm((f) => ({ ...f, accent: e.target.value }))} placeholder="#22D3EE" />
        </Field>
      </div>
    </Dialog>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={
        on
          ? "inline-flex h-7 items-center gap-1.5 rounded-md border border-fg-subtle bg-surface-2 px-2.5 text-[12.5px] text-fg"
          : "inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2.5 text-[12.5px] text-fg-subtle hover:border-border-strong"
      }
    >
      {on && <Check className="size-3" />}
      {children}
    </button>
  );
}

function CustomerDialog({ customer, onClose, onSaved }: { customer: CustomerDetail; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: customer.name, contactEmail: customer.contactEmail ?? "", notes: customer.notes ?? "" });
  const save = useMutation({
    mutationFn: () => patch(`/api/customers/${customer.id}`, form),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Edit customer"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!form.name.trim()} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Organization name">
          <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </Field>
        <Field label="Contact">
          <Input type="email" value={form.contactEmail} onChange={(e) => setForm((f) => ({ ...f, contactEmail: e.target.value }))} />
        </Field>
        <Field label="Notes">
          <Textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
        </Field>
      </div>
    </Dialog>
  );
}
