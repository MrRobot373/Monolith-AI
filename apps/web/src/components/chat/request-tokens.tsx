"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Dialog } from "@/components/ui/overlay";
import { post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatTokens } from "@/lib/format";

const PRESETS = [100_000, 500_000, 1_000_000, 5_000_000];

/** "Ask your admin for more tokens" (D13). */
export function RequestTokensDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
}) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState(PRESETS[2]!);
  const [custom, setCustom] = useState("");
  const [duration, setDuration] = useState<"period" | "permanent">("period");
  const [reason, setReason] = useState("");

  const m = useMutation({
    mutationFn: () =>
      post("/api/token-requests", {
        workspaceId,
        amount: custom ? Math.round(Number(custom) * 1000) : amount,
        duration,
        reason: reason || undefined,
      }),
    onSuccess: () => {
      toast.success("Request sent", { description: "Your admin has been notified. You'll get a notification when they decide." });
      qc.invalidateQueries({ queryKey: ["my-requests"] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Request more tokens"
      description="Your workspace admin will review the request."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} onClick={() => m.mutate()}>Send request</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Amount">
          <div className="grid grid-cols-4 gap-2">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => {
                  setAmount(p);
                  setCustom("");
                }}
                className={cn(
                  "h-9 rounded-lg border text-sm transition-colors",
                  !custom && amount === p ? "border-fg-subtle bg-surface-2 text-fg" : "border-border text-fg-muted hover:border-border-strong",
                )}
              >
                +{formatTokens(p)}
              </button>
            ))}
          </div>
          <Input
            className="mt-2"
            inputMode="numeric"
            placeholder="Custom amount (in thousands, e.g. 250)"
            value={custom}
            onChange={(e) => setCustom(e.target.value.replace(/[^0-9]/g, ""))}
          />
        </Field>
        <Field label="For">
          <div className="grid grid-cols-2 gap-2">
            {(["period", "permanent"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDuration(d)}
                className={cn(
                  "h-9 rounded-lg border text-sm transition-colors",
                  duration === d ? "border-fg-subtle bg-surface-2 text-fg" : "border-border text-fg-muted hover:border-border-strong",
                )}
              >
                {d === "period" ? "This period only" : "Raise my limit"}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Reason" hint="Optional, but it helps your admin decide.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="e.g. Preparing the quarterly report" />
        </Field>
      </div>
    </Dialog>
  );
}
