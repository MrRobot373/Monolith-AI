"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, KeyRound, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EmailSettings } from "@/components/admin/email-settings";
import { Section } from "@/components/admin/table";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { OrgLogo } from "@/components/org-logo";
import { Badge, Card, Switch } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import { Skeleton } from "@/components/ui/spinner";
import { ApiError, del, get, put } from "@/lib/api";
import { cn } from "@/lib/cn";
import { applyAccent } from "@/lib/theme";

interface OrgSettings {
  name: string;
  productName: string;
  accentColor: string;
  loginMessage: string | null;
  budgetPeriod: "day" | "week" | "month";
  promptLogging: boolean;
  retentionDays: number | null;
  hasLicense: boolean;
  logoUrl: string | null;
}

const ACCENTS = ["#22D3EE", "#60A5FA", "#A78BFA", "#34D399", "#FBBF24", "#F472B6", "#FB7185", "#FAFAFA"];

export default function SettingsPage() {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ["admin-settings"], queryFn: () => get<OrgSettings>("/api/admin/settings") });
  const [form, setForm] = useState<OrgSettings | null>(null);
  const [confirmLogging, setConfirmLogging] = useState(false);
  // Loaded once: a refetch (after a save or a logo upload) mustn't wipe edits not saved yet.
  useEffect(() => {
    if (s.data) setForm((f) => f ?? s.data);
  }, [s.data]);
  const logoUrl = s.data?.logoUrl ?? null;

  const save = useMutation({
    mutationFn: (body: Partial<OrgSettings>) => put("/api/admin/settings", body),
    onSuccess: () => {
      toast.success("Settings saved");
      qc.invalidateQueries({ queryKey: ["admin-settings"] });
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["public-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!form) return <Skeleton className="h-96 rounded-xl" />;
  const set = <K extends keyof OrgSettings>(k: K, v: OrgSettings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const validHex = /^#[0-9a-fA-F]{6}$/.test(form.accentColor);

  return (
    <div className="space-y-10">
      <PageHeader title="Settings" description="Organization details, branding, budgets and data policies." />

      <Section title="Organization & branding" description="Shown across the product and on the sign-in page.">
        <Card className="grid gap-8 p-5 lg:grid-cols-[1fr_280px]">
          <div className="space-y-4">
            <Field label="Organization name">
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <LogoField url={logoUrl} />
            <Field label="Product name" hint="White-label the product for your team, e.g. “Acme AI”.">
              <Input value={form.productName} onChange={(e) => set("productName", e.target.value)} />
            </Field>
            <Field label="Accent color">
              <div className="flex flex-wrap items-center gap-2">
                {ACCENTS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Accent ${c}`}
                    onClick={() => {
                      set("accentColor", c);
                      applyAccent(c);
                    }}
                    className={cn("size-7 rounded-full border-2 transition-transform hover:scale-110", form.accentColor.toLowerCase() === c.toLowerCase() ? "scale-110 border-fg" : "border-transparent")}
                    style={{ background: c }}
                  />
                ))}
                <Input
                  value={form.accentColor}
                  onChange={(e) => {
                    set("accentColor", e.target.value);
                    if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) applyAccent(e.target.value);
                  }}
                  className="w-28 font-mono text-[13px]"
                />
              </div>
            </Field>
            <Field label="Sign-in page message" hint="Optional. e.g. “For Acme employees only. Contact IT for access.”">
              <Textarea value={form.loginMessage ?? ""} onChange={(e) => set("loginMessage", e.target.value)} maxLength={280} rows={2} />
            </Field>
          </div>
          {/* Live preview */}
          <div className="rounded-xl border border-border bg-bg-subtle p-4">
            <div className="mb-3 text-[11px] font-medium tracking-wide text-fg-subtle uppercase">Preview</div>
            <div className="flex items-center gap-2">
              <OrgLogo src={logoUrl} className="size-6" />
              <span className="font-semibold">{form.productName || "Aatmiq"}</span>
            </div>
            <div className="mt-4 rounded-lg bg-surface-2 px-3 py-2 text-[13px]">Summarize this week&apos;s tickets</div>
            <div className="mt-3 flex items-center gap-2">
              <span className="h-2 w-24 rounded-full bg-accent" />
              <span className="h-2 w-10 rounded-full bg-surface-3" />
            </div>
            <Button variant="primary" size="sm" className="mt-4 w-full">Send</Button>
          </div>
        </Card>
        <Button
          variant="primary"
          disabled={!validHex}
          loading={save.isPending}
          onClick={() => save.mutate({ name: form.name, productName: form.productName, accentColor: form.accentColor.toUpperCase(), loginMessage: form.loginMessage ?? "" })}
        >
          Save branding
        </Button>
      </Section>

      <Section title="Budgets" description="How often token budgets and allowances reset for every workspace.">
        <Card className="flex flex-wrap items-end gap-4 p-5">
          <Field label="Budget period" className="w-56">
            <Select value={form.budgetPeriod} onChange={(e) => set("budgetPeriod", e.target.value as OrgSettings["budgetPeriod"])}>
              <option value="day">Daily</option>
              <option value="week">Weekly (Monday)</option>
              <option value="month">Monthly (1st)</option>
            </Select>
          </Field>
          <Button onClick={() => save.mutate({ budgetPeriod: form.budgetPeriod })}>Save</Button>
        </Card>
      </Section>

      <EmailSettings />

      <Section title="Data & privacy">
        <Card className="divide-y divide-border">
          <div className="flex items-start justify-between gap-6 p-5">
            <div>
              <div className="text-sm font-medium">Record conversations for compliance</div>
              <p className="mt-1 max-w-lg text-[13px] text-fg-muted">
                Off by default. When on, everyone sees a notice in the app that conversations are recorded.
              </p>
            </div>
            <Switch
              checked={form.promptLogging}
              onCheckedChange={(v) => (v ? setConfirmLogging(true) : (set("promptLogging", false), save.mutate({ promptLogging: false })))}
              label="Record conversations"
            />
          </div>
          <div className="flex flex-wrap items-end justify-between gap-4 p-5">
            <Field label="Delete chats automatically after" hint="Leave empty to keep chats until people delete them." className="w-64">
              <div className="flex items-center gap-2">
                <Input
                  inputMode="numeric"
                  value={form.retentionDays ?? ""}
                  onChange={(e) => set("retentionDays", e.target.value ? Number(e.target.value.replace(/\D/g, "")) : null)}
                  className="w-24"
                />
                <span className="text-sm text-fg-muted">days</span>
              </div>
            </Field>
            <Button onClick={() => save.mutate({ retentionDays: form.retentionDays })}>Save</Button>
          </div>
        </Card>
      </Section>

      <Section title="License">
        <Link href="/admin/license" className="flex items-center gap-3 rounded-xl border border-border bg-surface p-5 transition-colors hover:border-border-strong">
          <KeyRound className="size-4 text-fg-subtle" />
          <div className="flex-1 text-sm">Plan, seats and license server check-ins.</div>
          <ArrowUpRight className="size-4 text-fg-subtle" />
        </Link>
      </Section>

      <Dialog
        open={confirmLogging}
        onOpenChange={setConfirmLogging}
        title="Record all conversations?"
        description="Everyone in your organization will see a notice that their conversations are recorded."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmLogging(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                set("promptLogging", true);
                save.mutate({ promptLogging: true });
                setConfirmLogging(false);
              }}
            >
              Turn on recording
            </Button>
          </>
        }
      >
        <div className="flex gap-3 rounded-lg bg-warning-soft p-3 text-[13px] text-warning">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          Make sure this matches your employee privacy policy.
        </div>
      </Dialog>
    </div>
  );
}

/** Upload or remove the organization's logo. It saves on its own, apart from "Save branding". */
function LogoField({ url }: { url: string | null }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["admin-settings"] });
    qc.invalidateQueries({ queryKey: ["me"] });
    qc.invalidateQueries({ queryKey: ["public-status"] });
  };
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/admin/settings/logo", { method: "PUT", credentials: "include", body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, data.error ?? "Upload failed", data.code);
      return data as { logoUrl: string };
    },
    onSuccess: () => {
      toast.success("Logo updated");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => del("/api/admin/settings/logo"),
    onSuccess: () => {
      toast.success("Logo removed");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    // Not a <Field>: that is a <label>, and clicking its text would open the file picker.
    <div className="space-y-1.5">
      <span className="block text-[12.5px] font-medium text-fg-muted">Logo</span>
      <div className="flex items-center gap-3">
        <div className="flex size-12 items-center justify-center rounded-xl border border-border bg-bg-subtle p-1.5">
          <OrgLogo src={url} className="size-full" />
        </div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          className="hidden"
          data-testid="logo-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload.mutate(f);
            e.target.value = "";
          }}
        />
        <Button size="sm" onClick={() => input.current?.click()} loading={upload.isPending} data-testid="logo-upload">
          {url ? "Replace" : "Upload logo"}
        </Button>
        {url && (
          <Button size="sm" variant="ghost" onClick={() => remove.mutate()} loading={remove.isPending} data-testid="logo-remove">
            Remove
          </Button>
        )}
      </div>
      <span className="block text-xs text-fg-subtle">Square works best. PNG, JPEG, WebP or SVG, up to 512 KB. Shown on the sign-in page, in the app, in emails and as the browser tab icon.</span>
    </div>
  );
}
