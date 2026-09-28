"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Table, Td } from "@/components/admin/table";
import { PageHeader } from "@/components/app/page-header";
import { Select } from "@/components/ui/field";
import { Badge } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/spinner";
import { get } from "@/lib/api";

interface AuditRow {
  id: string;
  actorEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  meta: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

const FILTERS = [
  { v: "", l: "All events" },
  { v: "user.", l: "Users" },
  { v: "workspace.", l: "Workspaces" },
  { v: "model.", l: "Models" },
  { v: "provider.", l: "Providers" },
  { v: "budget.", l: "Budgets" },
  { v: "token_request.", l: "Token requests" },
  { v: "settings.", l: "Settings" },
];

function tone(action: string) {
  if (/deactivated|deleted|archived|denied|revoked|removed/.test(action)) return "danger" as const;
  if (/approved|created|added|setup|accepted/.test(action)) return "success" as const;
  return "neutral" as const;
}

export default function AuditPage() {
  const [filter, setFilter] = useState("");
  const q = useQuery({ queryKey: ["audit", filter], queryFn: () => get<AuditRow[]>(`/api/admin/audit?action=${encodeURIComponent(filter)}`) });
  return (
    <div className="space-y-6">
      <PageHeader title="Audit log" description="Every sign-up, permission change, approval and setting change in your organization." />
      <div className="w-56">
        <Select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter events">
          {FILTERS.map((f) => (
            <option key={f.v} value={f.v}>{f.l}</option>
          ))}
        </Select>
      </div>
      {q.isLoading ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : (
        <Table head={["When", "Who", "Event", "Details"]}>
          {q.data?.map((a) => (
            <tr key={a.id}>
              <Td className="whitespace-nowrap text-fg-muted tabular-nums">
                {new Date(a.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </Td>
              <Td className="text-fg-muted">{a.actorEmail ?? "system"}</Td>
              <Td>
                <Badge tone={tone(a.action)}>{a.action}</Badge>
              </Td>
              <Td className="max-w-md">
                <code className="block truncate font-mono text-[11.5px] text-fg-subtle">{a.meta ? JSON.stringify(a.meta) : (a.targetType ?? "")}</code>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
