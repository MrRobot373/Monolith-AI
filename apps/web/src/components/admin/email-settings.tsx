"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Section } from "@/components/admin/table";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Badge, Card } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/spinner";
import { del, get, post, put } from "@/lib/api";

type Security = "tls" | "starttls" | "none";
interface EmailServer {
  source: "env" | "settings" | null;
  host?: string;
  port?: number;
  security?: Security;
  username?: string | null;
  hasPassword?: boolean;
  from?: string;
}

const PORTS: Record<Security, number> = { starttls: 587, tls: 465, none: 25 };

/** Admin → Settings → Email: the mail server for invitations, password resets and security notices. */
export function EmailSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin-email"], queryFn: () => get<EmailServer>("/api/admin/email") });
  const [form, setForm] = useState({ host: "", port: 587, security: "starttls" as Security, username: "", password: "", from: "" });
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    const s = q.data;
    if (s?.source) setForm({ host: s.host ?? "", port: s.port ?? 587, security: s.security ?? "starttls", username: s.username ?? "", password: "", from: s.from ?? "" });
  }, [q.data]);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  // An empty password field keeps the saved one.
  const body = () => ({ ...form, username: form.username || null, password: form.password || (q.data?.hasPassword ? undefined : "") });

  const test = useMutation({
    mutationFn: () => post<{ to: string }>("/api/admin/email/test", editing || !q.data?.source ? body() : undefined),
    onSuccess: (r) => toast.success(`Test email sent to ${r.to}`),
    onError: (e: Error) => toast.error(e.message),
  });
  const save = useMutation({
    mutationFn: () => put("/api/admin/email", body()),
    onSuccess: () => {
      toast.success("Email settings saved");
      setEditing(false);
      qc.invalidateQueries({ queryKey: ["admin-email"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: () => del("/api/admin/email"),
    onSuccess: () => {
      toast.success("Email turned off");
      setForm({ host: "", port: 587, security: "starttls", username: "", password: "", from: "" });
      qc.invalidateQueries({ queryKey: ["admin-email"] });
    },
  });

  const s = q.data;
  return (
    <Section title="Email" description="Sends invitations, password reset links and security notices. Without it, you share invitation links yourself and send reset links from Users.">
      {!s ? (
        <Skeleton className="h-32 rounded-xl" />
      ) : s.source === "env" ? (
        <Card className="flex flex-wrap items-center gap-3 p-5" data-testid="email-env">
          <Mail className="size-4 text-fg-subtle" />
          <div className="min-w-0 flex-1 text-sm">
            Set by the server (<code className="font-mono text-[12px]">SMTP_URL</code>): {s.host}:{s.port}, from {s.from}
          </div>
          <Button onClick={() => test.mutate()} loading={test.isPending}>
            Send test email
          </Button>
        </Card>
      ) : s.source === "settings" && !editing ? (
        <Card className="flex flex-wrap items-center gap-3 p-5" data-testid="email-configured">
          <Mail className="size-4 text-fg-subtle" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-sm">
              {s.host}:{s.port} <Badge tone="success">On</Badge>
            </div>
            <div className="truncate text-[12.5px] text-fg-subtle">From {s.from}</div>
          </div>
          <Button onClick={() => test.mutate()} loading={test.isPending} data-testid="email-test">
            Send test email
          </Button>
          <Button variant="ghost" onClick={() => setEditing(true)}>
            Change
          </Button>
        </Card>
      ) : (
        <Card className="space-y-4 p-5" data-testid="email-form">
          <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
            <Field label="Mail server (SMTP)">
              <Input value={form.host} onChange={(e) => set("host", e.target.value)} placeholder="smtp.office365.com" data-testid="smtp-host" />
            </Field>
            <Field label="Port">
              <Input inputMode="numeric" value={form.port} onChange={(e) => set("port", Number(e.target.value.replace(/\D/g, "")) || 0)} data-testid="smtp-port" />
            </Field>
          </div>
          <Field label="Security">
            <Select
              value={form.security}
              onChange={(e) => {
                const v = e.target.value as Security;
                setForm((f) => ({ ...f, security: v, port: f.port === PORTS[f.security] ? PORTS[v] : f.port }));
              }}
              data-testid="smtp-security"
            >
              <option value="starttls">STARTTLS (usually port 587)</option>
              <option value="tls">TLS (usually port 465)</option>
              <option value="none">None (only for a relay on your own network)</option>
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Username" hint="Often the full sender address.">
              <Input value={form.username} onChange={(e) => set("username", e.target.value)} autoComplete="off" data-testid="smtp-username" />
            </Field>
            <Field label="Password" hint={s.hasPassword ? "Saved. Leave empty to keep it." : "An app password if your provider uses them."}>
              <Input type="password" value={form.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" placeholder={s.hasPassword ? "••••••••" : ""} data-testid="smtp-password" />
            </Field>
          </div>
          <Field label="Send as" hint='The sender people see, e.g. "Acme AI <ai@acme.com>". Your provider must allow this address.'>
            <Input value={form.from} onChange={(e) => set("from", e.target.value)} placeholder="Acme AI <ai@acme.com>" data-testid="smtp-from" />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!form.host || !form.from || !form.port} data-testid="email-save">
              Save
            </Button>
            <Button onClick={() => test.mutate()} loading={test.isPending} disabled={!form.host || !form.from || !form.port}>
              Send test email
            </Button>
            {editing && (
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
            {s.source === "settings" && (
              <Button variant="ghost" className="ml-auto text-danger" onClick={() => remove.mutate()} loading={remove.isPending}>
                Turn off email
              </Button>
            )}
          </div>
        </Card>
      )}
    </Section>
  );
}
