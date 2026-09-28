"use client";

import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import { BarList, DailyColumns, StatTile, type DailyPoint } from "@/components/admin/charts";
import { PageHeader } from "@/components/app/page-header";
import { useSession } from "@/components/app/session";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";
import { Card } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/spinner";
import { get } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatTokens } from "@/lib/format";
import type { WorkspaceRow } from "@/lib/types";

interface UsageReport {
  days: number;
  totals: { input: number; output: number; requests: number; activeUsers: number; avgLatencyMs: number; errors: number };
  daily: DailyPoint[];
  byModel: { id: string | null; name: string; tokens: number; requests: number }[];
  byUser: { id: string | null; name: string; email: string | null; tokens: number; requests: number }[];
  bySection: { section: string; tokens: number }[];
  byWorkspace: { id: string | null; name: string; tokens: number }[];
}

const RANGES = [7, 30, 90] as const;
const SECTION_LABELS: Record<string, string> = { chat: "Chat", work: "Work AI", code: "Code", api: "API", system: "System" };

export default function UsagePage() {
  const { me } = useSession();
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [ws, setWs] = useState("");
  const workspaces = useQuery({ queryKey: ["admin-workspaces"], queryFn: () => get<WorkspaceRow[]>("/api/admin/workspaces") });
  const report = useQuery({
    queryKey: ["admin-usage", days, ws],
    queryFn: () => get<UsageReport>(`/api/admin/usage?days=${days}${ws ? `&workspaceId=${ws}` : ""}`),
  });
  const d = report.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Usage"
        description="Token usage across workspaces, people and models. Conversation content is never shown here."
        actions={
          me.isAdmin && (
            <Button asChild>
              <a href={`/api/admin/usage/export?days=${days}${ws ? `&workspaceId=${ws}` : ""}`}>
                <Download className="size-4" /> Export CSV
              </a>
            </Button>
          )
        }
      />

      {/* Filters: one row above the charts */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-border bg-surface p-0.5">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setDays(r)}
              className={cn("h-7 rounded-md px-3 text-[13px] transition-colors", days === r ? "bg-surface-3 text-fg" : "text-fg-muted hover:text-fg")}
            >
              {r} days
            </button>
          ))}
        </div>
        <div className="w-56">
          <Select value={ws} onChange={(e) => setWs(e.target.value)} aria-label="Workspace">
            {me.isAdmin && <option value="">All workspaces</option>}
            {!me.isAdmin && <option value="">All my workspaces</option>}
            {workspaces.data?.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {d ? (
          <>
            <StatTile label="Total tokens" value={formatTokens(d.totals.input + d.totals.output)} hint={`${formatTokens(d.totals.input)} in · ${formatTokens(d.totals.output)} out`} />
            <StatTile label="Requests" value={d.totals.requests.toLocaleString()} hint={d.totals.errors ? `${d.totals.errors} errors` : "No errors"} />
            <StatTile label="Active people" value={String(d.totals.activeUsers)} />
            <StatTile label="Average response time" value={`${(d.totals.avgLatencyMs / 1000).toFixed(1)}s`} />
          </>
        ) : (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[98px] rounded-xl" />)
        )}
      </div>

      <Card className="p-5">
        <h2 className="text-[15px] font-medium">Tokens per day</h2>
        <p className="mb-4 text-xs text-fg-subtle">Input + output tokens. Hover a day for the split.</p>
        {d ? <DailyColumns data={d.daily} height={220} /> : <Skeleton className="h-[240px]" />}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-4 text-[15px] font-medium">By person</h2>
          {d ? <BarList rows={d.byUser.map((u) => ({ key: u.id ?? u.name, label: u.name, sub: u.email, value: u.tokens }))} /> : <Skeleton className="h-40" />}
        </Card>
        <Card className="p-5">
          <h2 className="mb-4 text-[15px] font-medium">By model</h2>
          {d ? <BarList rows={d.byModel.map((m) => ({ key: m.id ?? m.name, label: m.name, sub: `${m.requests} requests`, value: m.tokens }))} /> : <Skeleton className="h-40" />}
        </Card>
        <Card className="p-5">
          <h2 className="mb-4 text-[15px] font-medium">By workspace</h2>
          {d ? <BarList rows={d.byWorkspace.map((w) => ({ key: w.id ?? w.name, label: w.name, value: w.tokens }))} /> : <Skeleton className="h-40" />}
        </Card>
        <Card className="p-5">
          <h2 className="mb-4 text-[15px] font-medium">By section</h2>
          {d ? <BarList rows={d.bySection.map((s) => ({ key: s.section, label: SECTION_LABELS[s.section] ?? s.section, value: s.tokens }))} /> : <Skeleton className="h-40" />}
        </Card>
      </div>
    </div>
  );
}
