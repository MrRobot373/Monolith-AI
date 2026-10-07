"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CircleCheck, CircleX, KeyRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { DailyColumns, StatTile } from "@/components/admin/charts";
import { LICENSE_STATE } from "@/components/admin/license";
import { Section } from "@/components/admin/table";
import { PageHeader } from "@/components/app/page-header";
import { useSession } from "@/components/app/session";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/spinner";
import { get } from "@/lib/api";
import { formatTokens, timeAgo } from "@/lib/format";

interface Overview {
  users: { total: number; active: number };
  workspaces: number;
  pendingRequests: number;
  tokens30d: number;
  providers: { id: string; name: string; type: string; health: { ok: boolean; latencyMs?: number; error?: string; checkedAt: string } | null }[];
  license: { status: string; tier: string | null; seats: number | null; expiresAt: string | null; message: string | null };
}

export default function AdminOverview() {
  const { me } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (!me.isAdmin) router.replace("/admin/workspaces");
  }, [me.isAdmin, router]);
  const o = useQuery({ queryKey: ["admin-overview"], queryFn: () => get<Overview>("/api/admin/overview"), enabled: me.isAdmin });
  const u = useQuery({ queryKey: ["admin-usage", 30, ""], queryFn: () => get<any>("/api/admin/usage?days=30"), enabled: me.isAdmin });

  return (
    <div className="space-y-8">
      <PageHeader title="Overview" description={`How ${me.org.name} is using ${me.org.productName}.`} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {o.data ? (
          <>
            <StatTile label="Active users" value={String(o.data.users.active)} hint={`${o.data.users.total} total`} />
            <StatTile label="Workspaces" value={String(o.data.workspaces)} />
            <StatTile label="Tokens, last 30 days" value={formatTokens(o.data.tokens30d)} />
            <Link href="/admin/requests" className="block rounded-xl transition-transform hover:-translate-y-0.5">
              <StatTile label="Pending requests" value={String(o.data.pendingRequests)} hint={o.data.pendingRequests ? "Needs review →" : "All clear"} />
            </Link>
          </>
        ) : (
          [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[98px] rounded-xl" />)
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-[15px] font-medium">Tokens per day</h2>
              <p className="text-xs text-fg-subtle">Last 30 days, all workspaces</p>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link href="/admin/usage">Details <ArrowRight className="size-3.5" /></Link>
            </Button>
          </div>
          {u.data ? <DailyColumns data={u.data.daily} /> : <Skeleton className="h-[200px]" />}
        </Card>

        <div className="space-y-6">
          <Section title="Model providers" actions={<Button asChild variant="ghost" size="sm"><Link href="/admin/models">Manage</Link></Button>}>
            <Card className="divide-y divide-border">
              {o.data?.providers.length ? (
                o.data.providers.map((p) => (
                  <div key={p.id} className="flex items-center gap-3 px-4 py-3">
                    {p.health?.ok ? <CircleCheck className="size-4 text-success" /> : <CircleX className="size-4 text-danger" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{p.name}</div>
                      <div className="text-xs text-fg-subtle">
                        {p.type} {p.health?.checkedAt ? `· checked ${timeAgo(p.health.checkedAt)}` : ""}
                      </div>
                    </div>
                    {p.health?.latencyMs !== undefined && p.health.ok && <span className="text-xs text-fg-subtle tabular-nums">{p.health.latencyMs}ms</span>}
                  </div>
                ))
              ) : (
                <p className="px-4 py-6 text-center text-sm text-fg-subtle">No providers yet.</p>
              )}
            </Card>
          </Section>
          <JobsCard />
          <Section title="License">
            <Link href="/admin/license" className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4 transition-colors hover:border-border-strong">
              <KeyRound className="size-4 text-fg-subtle" />
              <div className="min-w-0 flex-1 text-sm">
                {o.data?.license.tier ? `${o.data.license.tier[0]!.toUpperCase()}${o.data.license.tier.slice(1)} plan · ${o.data.license.seats} seats` : "Development mode"}
              </div>
              {o.data && (
                <Badge tone={LICENSE_STATE[o.data.license.status]?.tone === "neutral" ? "neutral" : (LICENSE_STATE[o.data.license.status]?.tone ?? "neutral")}>
                  {LICENSE_STATE[o.data.license.status]?.label ?? o.data.license.status}
                </Badge>
              )}
            </Link>
          </Section>
        </div>
      </div>
    </div>
  );
}

interface JobsStatus {
  mode: "in-process" | "redis";
  workers: { id: string; seenAt: string }[];
  counts: { waiting: number; active: number; delayed: number; failed: number };
  stalled: boolean;
  documentsProcessing: number;
}

/** Where background jobs (document processing, housekeeping) run and whether they're keeping up. */
function JobsCard() {
  const q = useQuery({ queryKey: ["admin-jobs"], queryFn: () => get<JobsStatus>("/api/admin/jobs"), refetchInterval: 15_000 });
  const d = q.data;
  if (!d) return null;
  const ok = d.mode === "in-process" || (d.workers.length > 0 && !d.stalled);
  return (
    <Section title="Background jobs">
      <Card className="p-4" data-testid="jobs-card">
        <div className="flex items-center gap-3">
          {ok ? <CircleCheck className="size-4 text-success" /> : <CircleX className="size-4 text-danger" />}
          <div className="min-w-0 flex-1 text-sm">
            {d.mode === "in-process"
              ? "Running inside the API"
              : d.workers.length
                ? `${d.workers.length} ${d.workers.length === 1 ? "worker" : "workers"} running`
                : "No worker is running"}
          </div>
          <Badge>{d.mode === "redis" ? "Redis queue" : "Single server"}</Badge>
        </div>
        <div className="mt-2 text-xs text-fg-subtle">
          {d.counts.active} running · {d.counts.waiting + d.counts.delayed} waiting
          {d.counts.failed > 0 && ` · ${d.counts.failed} failed recently`}
          {d.documentsProcessing > 0 && ` · ${d.documentsProcessing} ${d.documentsProcessing === 1 ? "document" : "documents"} processing`}
        </div>
        {d.stalled && <p className="mt-2 text-xs text-danger">Jobs are waiting but no worker is running. Start the worker service (node dist/worker.js).</p>}
      </Card>
    </Section>
  );
}
