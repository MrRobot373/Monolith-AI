"use client";

import { DailyColumns, StatTile } from "@aatmiq/ui/charts";
import { timeAgo } from "@aatmiq/ui/format";
import { Badge, Card } from "@aatmiq/ui/misc";
import { Skeleton } from "@aatmiq/ui/spinner";
import { Section } from "@aatmiq/ui/table";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/shell";
import { get } from "@/lib/api";
import type { Overview } from "@/lib/types";

export default function OverviewPage() {
  const o = useQuery({ queryKey: ["overview"], queryFn: () => get<Overview>("/api/overview"), refetchInterval: 60_000 });
  if (!o.data) return <Skeleton className="h-96 rounded-xl" />;
  const d = o.data;
  const fill = d.seatsSold ? Math.round((d.seatsUsed / d.seatsSold) * 100) : 0;
  return (
    <div className="space-y-10">
      <PageHeader title="Overview" description="Licenses and deployment health across customers. Counts only: customer content never reaches this server." />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Customers" value={String(d.customers)} />
        <StatTile label="Active licenses" value={String(d.activeLicenses)} hint={d.expiringSoon ? `${d.expiringSoon} expire within 30 days` : "None expiring soon"} />
        <StatTile label="Seats in use" value={`${d.seatsUsed} / ${d.seatsSold}`} hint={`${fill}% of sold seats`} />
        <StatTile label="Quiet deployments" value={String(d.silent)} hint="No check-in for 3+ days" />
      </div>
      <Section title="Tokens across all deployments" description="Last 30 days, as reported by check-ins.">
        <Card className="p-4">
          <DailyColumns data={d.tokensDaily} />
        </Card>
      </Section>
      <Section title="Needs attention">
        {d.attention.length === 0 ? (
          <Card className="px-4 py-6 text-center text-[13px] text-fg-subtle">Everything looks fine.</Card>
        ) : (
          <Card className="divide-y divide-border">
            {d.attention.map((a) => {
              const days = Math.ceil((new Date(a.expiresAt).getTime() - Date.now()) / 86400_000);
              return (
                <Link key={a.id} href={`/customers/${a.customerId}`} className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px] hover:bg-surface-2/50">
                  <span className="min-w-0 flex-1 truncate text-fg">{a.customer}</span>
                  {days <= 30 && <Badge tone={days <= 0 ? "danger" : "warning"}>{days <= 0 ? "Expired" : `Expires in ${days}d`}</Badge>}
                  {a.instanceConflict && <Badge tone="danger">Key used on 2 servers</Badge>}
                  {(a.activeSeats ?? 0) > a.seats && <Badge tone="warning">Over seats</Badge>}
                  {a.lastCheckInAt && Date.now() - new Date(a.lastCheckInAt).getTime() > 3 * 86400_000 && <Badge tone="warning">Last seen {timeAgo(a.lastCheckInAt)}</Badge>}
                  <ArrowRight className="size-3.5 text-fg-subtle" />
                </Link>
              );
            })}
          </Card>
        )}
      </Section>
    </div>
  );
}
