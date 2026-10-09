"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Section } from "@/components/admin/table";
import { useSession } from "@/components/app/session";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Badge, Card, Switch } from "@/components/ui/misc";
import { get, post, put } from "@/lib/api";
import { TIER_NAMES } from "@/lib/format";
import type { ModelTier, Routing, RoutingSettingsValue } from "@aatmiq/shared";

interface TieredModel {
  id: string;
  displayName: string;
  kind: "chat" | "embedding";
  enabled: boolean;
  tier: ModelTier | null;
  thinkingSwitch: boolean;
}

function Row({ title, children, control }: { title: string; children: ReactNode; control: ReactNode }) {
  return (
    <div className="flex items-start gap-4 p-5">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] text-fg">{title}</div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-fg-subtle">{children}</p>
      </div>
      {control}
    </div>
  );
}

/** Admin → Models → Auto: picks the model for each message by how hard it is. */
export function AutoRouting({ models }: { models: TieredModel[] }) {
  const qc = useQueryClient();
  const { workspaceId } = useSession();
  const settings = useQuery({ queryKey: ["admin-routing"], queryFn: () => get<RoutingSettingsValue>("/api/admin/routing") });
  const save = useMutation({
    mutationFn: (body: Partial<RoutingSettingsValue>) => put<RoutingSettingsValue>("/api/admin/routing", body),
    onSuccess: (s) => {
      qc.setQueryData(["admin-routing"], s);
      qc.invalidateQueries({ queryKey: ["models"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const [text, setText] = useState("");
  const trial = useMutation({
    mutationFn: () => post<{ model: { displayName: string }; routing: Routing; ms: number }>("/api/admin/routing/try", { workspaceId, text }),
    onError: (e: Error) => toast.error(e.message),
  });

  const chat = models.filter((m) => m.kind === "chat" && m.enabled);
  const byTier = (["fast", "standard", "advanced"] as const).map((tier) => ({ tier, names: chat.filter((m) => m.tier === tier).map((m) => m.displayName) }));
  const tiers = byTier.filter((t) => t.names.length).length;
  const s = settings.data;

  return (
    <Section
      title="Auto"
      description="Picks the model for each message by how hard it is: quick questions to a fast model, everyday work to the standard one, hard problems to the strongest (with thinking on). Put models in tiers in the table below."
    >
      <Card className="divide-y divide-border" data-testid="auto-routing">
        <div className="flex flex-wrap gap-2 p-5">
          {byTier.map((t) => (
            <span key={t.tier} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12.5px]" data-testid={`tier-${t.tier}`}>
              <span className="text-fg-subtle">{TIER_NAMES[t.tier]}</span>
              <span className={t.names.length ? "text-fg" : "text-fg-subtle"}>{t.names.join(", ") || "none"}</span>
            </span>
          ))}
          {tiers < 2 && <Badge tone="warning">Auto needs models in at least two tiers</Badge>}
        </div>
        {s && (
          <>
            <Row title="Offer Auto" control={<Switch checked={s.enabled} onCheckedChange={(v) => save.mutate({ enabled: v })} label="Offer Auto" />}>
              Auto shows first in the model menus of Chat, Work AI and Code, wherever someone has models in two tiers.
            </Row>
            <Row title="Start with Auto" control={<Switch checked={s.default} disabled={!s.enabled} onCheckedChange={(v) => save.mutate({ default: v })} label="Start with Auto" />}>
              New chats and tasks use Auto unless people pick a model. Off: they start with the workspace&apos;s default model.
            </Row>
            <Row
              title="Unclear requests"
              control={
                <div className="flex flex-col items-end gap-2">
                  <Select value={s.judge} onChange={(e) => save.mutate({ judge: e.target.value as "rules" | "model" })} className="w-48" data-testid="auto-judge">
                    <option value="model">Ask a judge model</option>
                    <option value="rules">Rules only</option>
                  </Select>
                  {s.judge === "model" && (
                    <Select value={s.judgeModelId ?? ""} onChange={(e) => save.mutate({ judgeModelId: e.target.value || null })} className="w-48" aria-label="Judge model">
                      <option value="">The fast model</option>
                      {chat.map((m) => (
                        <option key={m.id} value={m.id}>{m.displayName}</option>
                      ))}
                    </Select>
                  )}
                </div>
              }
            >
              Greetings, quick rewrites, code with errors and multi-part analysis are recognized right away. For the rest a judge model reads the request
              and answers easy, medium or hard (a fraction of a second on a GPU; if it&apos;s slow, the standard model answers).
            </Row>
            <Row title="Think on hard requests" control={<Switch checked={s.thinkOnHard} onCheckedChange={(v) => save.mutate({ thinkOnHard: v })} label="Think on hard requests" />}>
              Models that can switch thinking (marked Thinking below) think before answering hard requests, and answer everything else directly.
            </Row>
          </>
        )}
        <div className="p-5">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) trial.mutate();
            }}
          >
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Try a message, e.g. “Fix this error in my Python script”" data-testid="auto-try-input" />
            <Button type="submit" variant="secondary" disabled={!text.trim() || trial.isPending || tiers < 2}>
              <Sparkles /> Try
            </Button>
          </form>
          {trial.data && (
            <p className="mt-3 text-[13px] text-fg-muted" data-testid="auto-try-result">
              <span className="text-fg">{trial.data.model.displayName}</span> ({TIER_NAMES[trial.data.routing.tier].toLowerCase()}): {trial.data.routing.reason}
              {trial.data.routing.thinking ? ", with thinking" : ""}. <span className="text-fg-subtle">Decided in {trial.data.ms} ms.</span>
            </p>
          )}
        </div>
      </Card>
    </Section>
  );
}
