"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, KeyRound, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LICENSE_STATE } from "@/components/admin/license";
import { Section } from "@/components/admin/table";
import { PageHeader } from "@/components/app/page-header";
import { useSession } from "@/components/app/session";
import { Button } from "@/components/ui/button";
import { Field, Textarea } from "@/components/ui/field";
import { Badge, Card, Meter } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import { Skeleton } from "@/components/ui/spinner";
import { get, post, put } from "@/lib/api";
import { timeAgo } from "@/lib/format";

interface LicenseSummary {
  required: boolean;
  state: string;
  canUse: boolean;
  canAdmin: boolean;
  message: string | null;
  daysLeft: number | null;
  license: {
    id: string;
    customer: string;
    tier: string;
    tierLabel: string;
    seats: number;
    sections: string[];
    features: { id: string; label: string }[];
    workspaceLimit: number | null;
    modelMode: "self" | "managed";
    issuedAt: string;
    expiresAt: string;
    checkInHours: number;
  } | null;
  seatsUsed: number;
  pendingInvites: number;
  checkIn: { instanceId: string; lastCheckInAt: string | null; lastAttemptAt: string | null; lastError: string | null; enabled: boolean } | null;
  release: { version: string; notes: string | null; url: string | null } | null;
  version: string | null;
}

const SECTION_LABEL: Record<string, string> = { chat: "Chat", work: "Work AI", code: "Code" };
const fmt = (d: string) => new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

export default function LicensePage() {
  const { me } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin-license"], queryFn: () => get<LicenseSummary>("/api/admin/license") });
  const [entering, setEntering] = useState(false);
  const [key, setKey] = useState("");
  const isOwner = me.user.orgRole === "owner";

  const refresh = (data: LicenseSummary) => {
    qc.setQueryData(["admin-license"], data);
    qc.invalidateQueries({ queryKey: ["me"] });
  };
  const install = useMutation({
    mutationFn: () => put<LicenseSummary>("/api/admin/license", { key }),
    onSuccess: (d) => {
      refresh(d);
      setEntering(false);
      setKey("");
      toast.success("License installed");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const checkIn = useMutation({
    mutationFn: () => post<LicenseSummary & { result: { ok: boolean; error?: string } }>("/api/admin/license/check-in"),
    onSuccess: (d) => {
      refresh(d);
      if (d.result.ok) toast.success("Checked in with the license server");
      else toast.error(d.result.error ?? "Check-in failed");
    },
  });

  if (!q.data) return <Skeleton className="h-96 rounded-xl" />;
  const d = q.data;
  const st = LICENSE_STATE[d.state] ?? { label: d.state, tone: "neutral" as const };
  const l = d.license;

  return (
    <div className="space-y-10">
      <PageHeader
        title="License"
        description="Your plan, seats and the connection to the Aatmiq license server. Only counts are ever sent: never chats, files or names."
        actions={
          isOwner &&
          d.required && (
            <Button variant="primary" size="sm" onClick={() => setEntering(true)}>
              <KeyRound className="size-3.5" /> Enter new key
            </Button>
          )
        }
      />

      {!d.required ? (
        <Card className="p-5 text-[13px] text-fg-muted">
          This server runs in <span className="text-fg">development mode</span>: no license public key is configured, so every feature is
          available and nothing is checked. Production installs set <code className="font-mono text-[12px]">LICENSE_PUBLIC_KEY</code>.
        </Card>
      ) : (
        <>
          <Card className="grid gap-6 p-5 md:grid-cols-[1fr_auto]">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-serif text-[24px] leading-tight" data-testid="license-tier">
                  {l ? `${l.tierLabel} plan` : "No license"}
                </span>
                <Badge tone={st.tone === "neutral" ? "neutral" : st.tone}>{st.label}</Badge>
              </div>
              {l && (
                <div className="mt-1 text-[13px] text-fg-subtle">
                  Licensed to {l.customer} · valid until {fmt(l.expiresAt)}
                  {d.daysLeft !== null && d.daysLeft <= 60 && d.daysLeft > 0 ? ` (${d.daysLeft} days left)` : ""}
                </div>
              )}
              {d.message && <p className="mt-3 text-[13px] text-warning">{d.message}</p>}
            </div>
            {l && (
              <div className="w-full min-w-56 md:w-64">
                <div className="flex items-baseline justify-between text-[13px]">
                  <span className="text-fg-muted">Seats</span>
                  <span className="tabular-nums" data-testid="license-seats">
                    {d.seatsUsed} / {l.seats}
                  </span>
                </div>
                <Meter className="mt-2" value={d.seatsUsed / Math.max(1, l.seats)} />
                <div className="mt-1.5 text-[11.5px] text-fg-subtle">
                  {d.pendingInvites ? `${d.pendingInvites} pending invitation${d.pendingInvites === 1 ? "" : "s"} also reserve seats.` : "Active people use a seat. Deactivated people don't."}
                </div>
              </div>
            )}
          </Card>

          {l && (
            <Section title="What's included">
              <Card className="grid gap-0 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                <div className="p-4">
                  <div className="text-[12px] text-fg-subtle">Sections</div>
                  <div className="mt-2 space-y-1.5">
                    {["chat", "work", "code"].map((s) => (
                      <div key={s} className={l.sections.includes(s) ? "flex items-center gap-2 text-[13px] text-fg" : "flex items-center gap-2 text-[13px] text-fg-subtle line-through"}>
                        <Check className={l.sections.includes(s) ? "size-3.5 text-success" : "size-3.5 opacity-0"} /> {SECTION_LABEL[s]}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="p-4">
                  <div className="text-[12px] text-fg-subtle">Features</div>
                  <div className="mt-2 space-y-1.5">
                    {l.features.length ? (
                      l.features.map((f) => (
                        <div key={f.id} className="flex items-center gap-2 text-[13px] text-fg">
                          <Check className="size-3.5 text-success" /> {f.label}
                        </div>
                      ))
                    ) : (
                      <span className="text-[13px] text-fg-subtle">None</span>
                    )}
                  </div>
                </div>
                <div className="space-y-2 p-4 text-[13px]">
                  <div className="text-[12px] text-fg-subtle">Limits</div>
                  <div>{l.workspaceLimit ? `${l.workspaceLimit} workspaces` : "Unlimited workspaces"}</div>
                  <div>{l.modelMode === "managed" ? "Models managed by Aatmiq" : "Models managed by your admins"}</div>
                  <div className="text-fg-subtle">Issued {fmt(l.issuedAt)}</div>
                </div>
              </Card>
            </Section>
          )}

          <Section
            title="License server"
            description="This server checks in about once a day. Without check-ins Aatmiq keeps working for 14 days, then shows a warning; after 30 days admin changes pause until it reconnects."
            actions={
              <Button variant="outline" size="sm" loading={checkIn.isPending} disabled={!d.checkIn?.enabled || !l} onClick={() => checkIn.mutate()}>
                <RefreshCw className="size-3.5" /> Check in now
              </Button>
            }
          >
            <Card className="divide-y divide-border text-[13px]">
              <Row label="Last check-in" value={d.checkIn?.lastCheckInAt ? timeAgo(d.checkIn.lastCheckInAt) : "Never"} testid="last-check-in" />
              {d.checkIn?.lastError && <Row label="Last error" value={<span className="text-danger">{d.checkIn.lastError}</span>} />}
              <Row label="Check-ins" value={d.checkIn?.enabled ? `Every ${l?.checkInHours ?? 24} hours` : "Off (air-gapped)"} />
              <Row label="Installation id" value={<code className="font-mono text-[12px]">{d.checkIn?.instanceId}</code>} />
              <Row label="Version" value={d.version ?? "—"} />
              {d.release && d.release.version !== d.version && (
                <Row
                  label="Update available"
                  value={
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone="accent">{d.release.version}</Badge>
                      {d.release.notes && <span className="text-fg-muted">{d.release.notes}</span>}
                      {d.release.url && (
                        <a href={d.release.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-fg underline-offset-2 hover:underline">
                          Release notes <ArrowUpRight className="size-3" />
                        </a>
                      )}
                    </span>
                  }
                />
              )}
            </Card>
          </Section>
        </>
      )}

      <Dialog
        open={entering}
        onOpenChange={setEntering}
        title="Enter a new license key"
        description="Paste the key you received from Aatmiq. It's verified on this server."
        className="max-w-lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEntering(false)}>Cancel</Button>
            <Button variant="primary" disabled={key.trim().length < 20} loading={install.isPending} onClick={() => install.mutate()}>
              Install key
            </Button>
          </>
        }
      >
        <Field label="License key">
          <Textarea value={key} onChange={(e) => setKey(e.target.value)} className="min-h-32 font-mono text-[11.5px] break-all" data-testid="license-key-input" />
        </Field>
      </Dialog>
    </div>
  );
}

function Row({ label, value, testid }: { label: string; value: React.ReactNode; testid?: string }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <span className="w-40 shrink-0 text-fg-subtle">{label}</span>
      <span className="min-w-0 flex-1" data-testid={testid}>
        {value}
      </span>
    </div>
  );
}
