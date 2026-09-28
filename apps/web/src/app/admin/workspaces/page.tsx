"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, Inbox, Plus, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/page-header";
import { useSession } from "@/components/app/session";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Badge, Meter } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import { Skeleton } from "@/components/ui/spinner";
import { get, post } from "@/lib/api";
import { formatTokens } from "@/lib/format";
import type { WorkspaceRow } from "@/lib/types";


const ICONS = ["✦", "◆", "●", "▲", "■", "⬢", "✳", "☾"];

export default function WorkspacesPage() {
  const { me } = useSession();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["admin-workspaces"], queryFn: () => get<WorkspaceRow[]>("/api/admin/workspaces") });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState(ICONS[1]!);
  const create = useMutation({
    mutationFn: () => post<WorkspaceRow>("/api/admin/workspaces", { name, icon }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-workspaces"] });
      toast.success(`Created ${name}`);
      setOpen(false);
      setName("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-8">
      <PageHeader
        title="Workspaces"
        description="Each team gets its own models, token budget and members."
        actions={
          me.isAdmin && (
            <Button variant="primary" onClick={() => setOpen(true)}>
              <Plus className="size-4" /> New workspace
            </Button>
          )
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {list.isLoading && [0, 1, 2].map((i) => <Skeleton key={i} className="h-44 rounded-xl" />)}
        {list.data?.map((w) => {
          const frac = w.tokenLimit ? w.used / w.tokenLimit : null;
          return (
            <Link
              key={w.id}
              href={`/admin/workspaces/${w.id}`}
              className="group rounded-xl border border-border bg-surface p-5 transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-border-strong"
            >
              <div className="flex items-start justify-between">
                <div className="flex size-9 items-center justify-center rounded-lg bg-surface-2 text-base">{w.icon ?? "◆"}</div>
                {w.pendingRequests > 0 && (
                  <Badge tone="warning">
                    <Inbox className="size-3" /> {w.pendingRequests}
                  </Badge>
                )}
              </div>
              <div className="mt-4 font-medium">{w.name}</div>
              <div className="mt-1 flex gap-3 text-xs text-fg-subtle">
                <span className="inline-flex items-center gap-1"><Users className="size-3" /> {w.memberCount}</span>
                <span className="inline-flex items-center gap-1"><Cpu className="size-3" /> {w.modelCount} models</span>
              </div>
              <div className="mt-5 flex justify-between text-xs">
                <span className="text-fg-muted">{formatTokens(w.used)} used</span>
                <span className="text-fg-subtle">{w.tokenLimit === null ? "No budget" : `of ${formatTokens(w.tokenLimit)}`}</span>
              </div>
              <Meter value={frac} className="mt-1.5" />
            </Link>
          );
        })}
      </div>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="New workspace"
        description="For example a team or department. You can add members and models next."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create</Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Engineering" onKeyDown={(e) => e.key === "Enter" && name.trim() && create.mutate()} />
          </Field>
          <Field label="Icon">
            <div className="flex gap-1.5">
              {ICONS.map((i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setIcon(i)}
                  className={`flex size-9 items-center justify-center rounded-lg border text-base transition-colors ${icon === i ? "border-accent bg-accent-soft" : "border-border hover:border-border-strong"}`}
                >
                  {i}
                </button>
              ))}
            </div>
          </Field>
        </div>
      </Dialog>
    </div>
  );
}
