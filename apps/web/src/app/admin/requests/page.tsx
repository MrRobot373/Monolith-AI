"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Inbox, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Section, Table, Td } from "@/components/admin/table";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Avatar, Badge, Card, EmptyState, Meter } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import { Skeleton } from "@/components/ui/spinner";
import { get, post } from "@/lib/api";
import { formatTokens, timeAgo } from "@/lib/format";
import type { TokenRequestRow } from "@/lib/types";

export default function RequestsPage() {
  const qc = useQueryClient();
  const pending = useQuery({
    queryKey: ["review-requests", "pending"],
    queryFn: () => get<TokenRequestRow[]>("/api/token-requests?scope=review&status=pending"),
  });
  const history = useQuery({
    queryKey: ["review-requests", "all"],
    queryFn: () => get<TokenRequestRow[]>("/api/token-requests?scope=review"),
  });
  const [deciding, setDeciding] = useState<{ r: TokenRequestRow; decision: "approved" | "denied" } | null>(null);

  const decide = useMutation({
    mutationFn: (v: { id: string; decision: "approved" | "denied"; amount?: number; note?: string }) =>
      post(`/api/token-requests/${v.id}/decide`, { decision: v.decision, amount: v.amount, note: v.note }),
    onSuccess: (_d, v) => {
      toast.success(v.decision === "approved" ? "Approved. They can continue now." : "Request declined");
      qc.invalidateQueries({ queryKey: ["review-requests"] });
      qc.invalidateQueries({ queryKey: ["admin-overview"] });
      qc.invalidateQueries({ queryKey: ["admin-workspaces"] });
      setDeciding(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-10">
      <PageHeader title="Token requests" description="People who've reached their allowance and asked for more." />

      <Section title="Waiting for you">
        {pending.isLoading ? (
          <Skeleton className="h-32 rounded-xl" />
        ) : pending.data?.length ? (
          <div className="space-y-3">
            {pending.data.map((r) => {
              const q = r.quota;
              const limit = q?.user.limit === null || q?.user.limit === undefined ? null : q.user.limit + q.user.bonus;
              return (
                <Card key={r.id} className="animate-rise p-4">
                  <div className="flex flex-wrap items-start gap-4">
                    <Avatar name={r.userName} className="size-9" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm">
                        <span className="font-medium">{r.userName}</span>
                        <span className="text-fg-muted"> asked for </span>
                        <span className="font-medium">+{formatTokens(r.amount)}</span>
                        <span className="text-fg-muted"> in {r.workspaceName}</span>
                      </div>
                      <div className="mt-0.5 text-xs text-fg-subtle">
                        {timeAgo(r.createdAt)} · {r.duration === "period" ? "this period only" : "raise their limit"}
                      </div>
                      {r.reason && <p className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-fg-muted">“{r.reason}”</p>}
                      {q && (
                        <div className="mt-3 max-w-sm">
                          <div className="flex justify-between text-xs text-fg-subtle">
                            <span>Used {formatTokens(q.user.used)}</span>
                            <span>{limit === null ? "no limit" : `of ${formatTokens(limit)}`}</span>
                          </div>
                          <Meter className="mt-1" value={limit ? q.user.used / limit : null} />
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button variant="ghost" onClick={() => setDeciding({ r, decision: "denied" })}>
                        <X className="size-4" /> Decline
                      </Button>
                      <Button onClick={() => setDeciding({ r, decision: "approved" })}>Adjust…</Button>
                      <Button variant="primary" loading={decide.isPending && decide.variables?.id === r.id} onClick={() => decide.mutate({ id: r.id, decision: "approved" })}>
                        <Check className="size-4" /> Approve
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        ) : (
          <Card>
            <EmptyState icon={<Inbox className="size-5" />} title="No pending requests" description="When someone runs out of tokens and asks for more, it shows up here." />
          </Card>
        )}
      </Section>

      <Section title="History">
        <Table head={["Person", "Workspace", "Requested", "Decision", "When"]}>
          {history.data
            ?.filter((r) => r.status !== "pending")
            .map((r) => (
              <tr key={r.id}>
                <Td>
                  <div className="font-medium">{r.userName}</div>
                  <div className="text-xs text-fg-subtle">{r.userEmail}</div>
                </Td>
                <Td className="text-fg-muted">{r.workspaceName}</Td>
                <Td className="tabular-nums">+{formatTokens(r.amount)}</Td>
                <Td>
                  <Badge tone={r.status === "approved" ? "success" : "danger"}>
                    {r.status === "approved" ? `Approved +${formatTokens(r.decidedAmount)}` : "Declined"}
                  </Badge>
                  {r.note && <div className="mt-1 text-xs text-fg-subtle">“{r.note}”</div>}
                </Td>
                <Td className="text-fg-muted">{r.decidedAt ? timeAgo(r.decidedAt) : ""}</Td>
              </tr>
            ))}
        </Table>
      </Section>

      {deciding && (
        <DecideDialog
          request={deciding.r}
          decision={deciding.decision}
          loading={decide.isPending}
          onClose={() => setDeciding(null)}
          onSubmit={(amount, note) => decide.mutate({ id: deciding.r.id, decision: deciding.decision, amount, note })}
        />
      )}
    </div>
  );
}

function DecideDialog({
  request,
  decision,
  loading,
  onClose,
  onSubmit,
}: {
  request: TokenRequestRow;
  decision: "approved" | "denied";
  loading: boolean;
  onClose: () => void;
  onSubmit: (amount: number | undefined, note: string | undefined) => void;
}) {
  const [amount, setAmount] = useState(String(Math.round(request.amount / 1000)));
  const [note, setNote] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={decision === "approved" ? `Approve for ${request.userName}` : `Decline ${request.userName}'s request`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant={decision === "approved" ? "primary" : "danger"}
            loading={loading}
            onClick={() => onSubmit(decision === "approved" ? Math.max(1, Number(amount)) * 1000 : undefined, note || undefined)}
          >
            {decision === "approved" ? "Approve" : "Decline"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {decision === "approved" && (
          <Field label="Amount to grant" hint={`They asked for ${formatTokens(request.amount)}.`}>
            <div className="flex items-center gap-2">
              <Input inputMode="numeric" className="w-36" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))} />
              <span className="text-sm text-fg-muted">thousand tokens</span>
            </div>
          </Field>
        )}
        <Field label="Note" hint="Optional. They'll see it in their notification.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
      </div>
    </Dialog>
  );
}
