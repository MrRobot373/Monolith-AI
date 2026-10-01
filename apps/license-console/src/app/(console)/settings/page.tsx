"use client";

import { Button } from "@aatmiq/ui/button";
import { timeAgo } from "@aatmiq/ui/format";
import { Field, Input, Textarea } from "@aatmiq/ui/field";
import { Card } from "@aatmiq/ui/misc";
import { Skeleton } from "@aatmiq/ui/spinner";
import { Section, Table, Td } from "@aatmiq/ui/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell";
import { get, put } from "@/lib/api";

interface Settings {
  release: { version: string; notes: string | null; url: string | null; publishedAt: string } | null;
  publicKeyPem: string;
  publicKey: string;
  kid: string;
}
interface AuditRow {
  id: string;
  action: string;
  target: string | null;
  meta: unknown;
  createdAt: string;
  admin: string | null;
}

export default function SettingsPage() {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ["settings"], queryFn: () => get<Settings>("/api/settings") });
  const audit = useQuery({ queryKey: ["audit"], queryFn: () => get<AuditRow[]>("/api/audit") });
  const [rel, setRel] = useState({ version: "", notes: "", url: "" });
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (s.data?.release) setRel({ version: s.data.release.version, notes: s.data.release.notes ?? "", url: s.data.release.url ?? "" });
  }, [s.data?.release]);
  const publish = useMutation({
    mutationFn: () => put("/api/settings/release", rel),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
      toast.success("Published. Deployments see it at their next check-in.");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!s.data) return <Skeleton className="h-96 rounded-xl" />;
  const envLine = `LICENSE_PUBLIC_KEY=${s.data.publicKey}`;

  return (
    <div className="space-y-10">
      <PageHeader title="Settings" description="Signing key, release channel and the activity log." />

      <Section title="License public key" description="Every Aatmiq build verifies license keys with this key, offline. Set it in each deployment's environment.">
        <Card className="space-y-3 p-5">
          <div className="flex gap-2">
            <Input readOnly value={envLine} className="font-mono text-[12px]" data-testid="public-key" />
            <Button
              variant="outline"
              size="icon"
              aria-label="Copy"
              onClick={() => {
                void navigator.clipboard.writeText(envLine);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
          </div>
          <p className="text-[12px] text-fg-subtle">
            Key id <code className="font-mono">{s.data.kid}</code>. The private key never leaves this server (stored encrypted). Rotating it means re-issuing every license.
          </p>
        </Card>
      </Section>

      <Section title="Release channel" description="Shown to customer admins in Admin → License when their version is older.">
        <Card className="grid gap-4 p-5 sm:grid-cols-2">
          <Field label="Latest version">
            <Input value={rel.version} onChange={(e) => setRel((r) => ({ ...r, version: e.target.value }))} placeholder="1.2.0" />
          </Field>
          <Field label="Release notes link">
            <Input value={rel.url} onChange={(e) => setRel((r) => ({ ...r, url: e.target.value }))} placeholder="https://aatmiq.com/changelog" />
          </Field>
          <Field label="Summary" className="sm:col-span-2">
            <Textarea value={rel.notes} onChange={(e) => setRel((r) => ({ ...r, notes: e.target.value }))} placeholder="Faster search, Excel files, bug fixes." />
          </Field>
          <div className="flex items-center gap-3 sm:col-span-2">
            <Button variant="primary" disabled={!rel.version.trim()} loading={publish.isPending} onClick={() => publish.mutate()}>Publish</Button>
            {s.data.release && <span className="text-[12px] text-fg-subtle">Published {timeAgo(s.data.release.publishedAt)}</span>}
          </div>
        </Card>
      </Section>

      <Section title="Activity">
        <Table head={["When", "Who", "What", "Details"]}>
          {(audit.data ?? []).map((a) => (
            <tr key={a.id}>
              <Td className="whitespace-nowrap text-fg-muted">{timeAgo(a.createdAt)}</Td>
              <Td>{a.admin ?? "—"}</Td>
              <Td className="font-mono text-[12px]">{a.action}</Td>
              <Td className="max-w-80 truncate text-[12px] text-fg-subtle">{a.meta ? JSON.stringify(a.meta) : ""}</Td>
            </tr>
          ))}
        </Table>
      </Section>
    </div>
  );
}
