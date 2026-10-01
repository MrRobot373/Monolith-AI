"use client";

import { Button } from "@aatmiq/ui/button";
import { timeAgo } from "@aatmiq/ui/format";
import { Field, Input, Textarea } from "@aatmiq/ui/field";
import { Badge } from "@aatmiq/ui/misc";
import { Dialog } from "@aatmiq/ui/overlay";
import { Skeleton } from "@aatmiq/ui/spinner";
import { Table, Td } from "@aatmiq/ui/table";
import { TIERS } from "@aatmiq/license";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/shell";
import { get, post } from "@/lib/api";
import type { CustomerRow } from "@/lib/types";

export default function CustomersPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["customers"], queryFn: () => get<CustomerRow[]>("/api/customers") });
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", contactEmail: "", notes: "" });
  const create = useMutation({
    mutationFn: () => post<{ id: string }>("/api/customers", form),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      setCreating(false);
      router.push(`/customers/${c.id}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const rows = useMemo(() => (list.data ?? []).filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase())), [list.data, q]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customers"
        description="Organizations that run Aatmiq, and the license each one uses."
        actions={
          <Button variant="primary" size="sm" onClick={() => { setForm({ name: "", contactEmail: "", notes: "" }); setCreating(true); }}>
            <Plus className="size-3.5" /> New customer
          </Button>
        }
      />
      <label className="flex h-8 w-72 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 focus-within:border-border-strong">
        <Search className="size-3.5 text-fg-subtle" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customers" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-subtle" />
      </label>
      {list.isLoading ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : (
        <Table head={["Customer", "Plan", "Seats", "Expires", "Last check-in", "Status"]}>
          {rows.map((c) => {
            const expired = c.expiresAt && new Date(c.expiresAt) < new Date();
            return (
              <tr key={c.id} onClick={() => router.push(`/customers/${c.id}`)} className="cursor-pointer hover:bg-surface-2/40" data-testid="customer-row">
                <Td>
                  <div className="text-fg">{c.name}</div>
                  <div className="text-[12px] text-fg-subtle">{c.contactEmail ?? "No contact"}</div>
                </Td>
                <Td>{c.tier ? (TIERS[c.tier as keyof typeof TIERS]?.label ?? c.tier) : <span className="text-fg-subtle">—</span>}</Td>
                <Td className="tabular-nums">{c.seats ? `${c.activeSeats ?? 0} / ${c.seats}` : "—"}</Td>
                <Td>{c.expiresAt ? new Date(c.expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—"}</Td>
                <Td className="text-fg-muted">{c.lastCheckInAt ? timeAgo(c.lastCheckInAt) : "Never"}</Td>
                <Td>
                  {!c.status ? (
                    <Badge>No license</Badge>
                  ) : c.status === "revoked" ? (
                    <Badge tone="danger">Revoked</Badge>
                  ) : expired ? (
                    <Badge tone="warning">Expired</Badge>
                  ) : (
                    <Badge tone="success">Active</Badge>
                  )}
                </Td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <Td className="py-10 text-center text-fg-subtle" >
                {q ? "No customers match." : "No customers yet."}
              </Td>
            </tr>
          )}
        </Table>
      )}

      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="New customer"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" disabled={!form.name.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Organization name">
            <Input autoFocus value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Acme Labs Pvt Ltd" />
          </Field>
          <Field label="Billing / license contact">
            <Input type="email" value={form.contactEmail} onChange={(e) => setForm((f) => ({ ...f, contactEmail: e.target.value }))} placeholder="it@acme.com" />
          </Field>
          <Field label="Notes">
            <Textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Contract, hardware, contacts…" />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
