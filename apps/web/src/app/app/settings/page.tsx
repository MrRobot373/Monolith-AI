"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArchiveRestore, Monitor, Moon, Settings, Sun, Trash2 } from "lucide-react";
import Link from "next/link";
import { TopBar } from "@/components/app/frame";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app/page-header";
import { useSession } from "@/components/app/session";
import { RequestTokensDialog } from "@/components/chat/request-tokens";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Avatar, Badge, Card, Meter } from "@/components/ui/misc";
import { del, get, patch } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatTokens, timeAgo } from "@/lib/format";
import { applyTheme, readTheme, type ThemePref } from "@/lib/theme";
import type { ChatSummary, QuotaStatus, TokenRequestRow } from "@/lib/types";

const TABS = ["Profile", "Appearance", "Usage", "Archived chats"] as const;

export default function SettingsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Profile");
  useEffect(() => {
    if (window.location.hash === "#usage") setTab("Usage");
    if (window.location.hash === "#archived") setTab("Archived chats");
  }, []);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar icon={<Settings />} title="Settings" />
      <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-4 pt-10 pb-16 sm:px-6">
        <PageHeader title="Settings" description="Manage your profile, appearance, usage and archived chats." />
        <div className="mt-6 flex gap-1 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "relative px-3 pb-2.5 text-sm transition-colors",
                tab === t ? "text-fg" : "text-fg-muted hover:text-fg",
              )}
            >
              {t}
              {tab === t && <span className="absolute inset-x-2 -bottom-px h-px bg-fg" />}
            </button>
          ))}
        </div>
        <div key={tab} className="animate-rise pt-6">
          {tab === "Profile" && <Profile />}
          {tab === "Appearance" && <Appearance />}
          {tab === "Usage" && <Usage />}
          {tab === "Archived chats" && <ArchivedChats />}
        </div>
      </div>
      </div>
    </div>
  );
}

function Profile() {
  const { me } = useSession();
  const qc = useQueryClient();
  const [name, setName] = useState(me.user.name);
  const [jobTitle, setJobTitle] = useState(me.user.jobTitle ?? "");
  const [ci, setCi] = useState(me.user.customInstructions ?? "");
  const save = useMutation({
    mutationFn: () => patch("/api/me", { name, jobTitle, customInstructions: ci }),
    onSuccess: () => {
      toast.success("Profile saved");
      qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4">
        <Avatar name={me.user.name} image={me.user.image} className="size-14 text-base" />
        <div>
          <div className="font-medium">{me.user.email}</div>
          <div className="mt-1 flex gap-1.5">
            <Badge tone={me.user.orgRole === "member" ? "neutral" : "accent"}>{me.user.orgRole}</Badge>
            <span className="text-xs text-fg-subtle">{me.org.name}</span>
          </div>
        </div>
      </div>
      <Field label="Full name">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Job title">
        <Input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="e.g. Finance lead" />
      </Field>
      <Field label="Custom instructions" hint="Aatmiq considers these in every chat, e.g. your role, preferred tone or formatting.">
        <Textarea rows={4} value={ci} onChange={(e) => setCi(e.target.value)} maxLength={4000} placeholder="I'm a backend engineer. Prefer concise answers with TypeScript examples." />
      </Field>
      <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
        Save changes
      </Button>
    </div>
  );
}

function Appearance() {
  const [pref, setPref] = useState<ThemePref>("dark");
  useEffect(() => setPref(readTheme()), []);
  const opts: { v: ThemePref; label: string; icon: typeof Moon }[] = [
    { v: "dark", label: "Dark", icon: Moon },
    { v: "light", label: "Light", icon: Sun },
    { v: "system", label: "System", icon: Monitor },
  ];
  return (
    <Field label="Theme">
      <div className="grid grid-cols-3 gap-3 pt-1">
        {opts.map((o) => (
          <button
            key={o.v}
            onClick={() => {
              setPref(o.v);
              applyTheme(o.v);
            }}
            className={cn(
              "flex flex-col items-center gap-2 rounded-xl border p-4 text-sm transition-colors",
              pref === o.v ? "border-fg-subtle bg-surface-2 text-fg" : "border-border text-fg-muted hover:border-border-strong",
            )}
          >
            <o.icon className="size-5" />
            {o.label}
          </button>
        ))}
      </div>
    </Field>
  );
}

function Usage() {
  const { me } = useSession();
  const [requestFor, setRequestFor] = useState<string | null>(null);
  const requests = useQuery({
    queryKey: ["my-requests"],
    queryFn: () => get<TokenRequestRow[]>("/api/token-requests?scope=mine"),
  });
  return (
    <div className="space-y-4">
      {me.workspaces.map((w) => (
        <WorkspaceUsage key={w.id} id={w.id} name={w.name} onRequest={() => setRequestFor(w.id)} />
      ))}
      <div className="pt-4">
        <h3 className="mb-3 text-sm font-medium">Your requests</h3>
        {requests.data?.length ? (
          <Card className="divide-y divide-border">
            {requests.data.map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div>
                    +{formatTokens(r.amount)} in <span className="text-fg-muted">{r.workspaceName}</span>
                  </div>
                  <div className="text-xs text-fg-subtle">
                    {timeAgo(r.createdAt)}
                    {r.note ? ` · “${r.note}”` : ""}
                  </div>
                </div>
                <Badge tone={r.status === "approved" ? "success" : r.status === "denied" ? "danger" : "warning"}>
                  {r.status === "approved" && r.decidedAmount !== r.amount ? `approved ${formatTokens(r.decidedAmount)}` : r.status}
                </Badge>
              </div>
            ))}
          </Card>
        ) : (
          <p className="text-sm text-fg-subtle">You haven&apos;t requested extra tokens.</p>
        )}
      </div>
      {requestFor && <RequestTokensDialog open onOpenChange={(o) => !o && setRequestFor(null)} workspaceId={requestFor} />}
    </div>
  );
}

function WorkspaceUsage({ id, name, onRequest }: { id: string; name: string; onRequest: () => void }) {
  const q = useQuery({ queryKey: ["quota", id], queryFn: () => get<QuotaStatus>(`/api/workspaces/${id}/quota`) });
  const d = q.data;
  const limit = d?.user.limit === null || d?.user.limit === undefined ? null : d.user.limit + d.user.bonus;
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">{name}</div>
          <div className="text-xs text-fg-subtle">
            {d ? `Resets ${new Date(d.resetsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : " "}
          </div>
        </div>
        <Button size="sm" onClick={onRequest}>Request more</Button>
      </div>
      <div className="mt-4 flex items-baseline justify-between text-sm">
        <span>
          <span className="font-mono text-base font-medium">{formatTokens(d?.user.used ?? 0)}</span>
          <span className="text-fg-muted"> used</span>
        </span>
        <span className="text-fg-muted">{limit === null ? "No limit" : `of ${formatTokens(limit)}`}</span>
      </div>
      <Meter className="mt-2" value={limit === null ? 0 : (d?.user.used ?? 0) / Math.max(1, limit)} />
      {d && d.user.bonus > 0 && <div className="mt-2 text-xs text-fg-subtle">Includes +{formatTokens(d.user.bonus)} approved this period.</div>}
    </Card>
  );
}

function ArchivedChats() {
  const { workspaceId, workspace } = useSession();
  const qc = useQueryClient();
  const archived = useQuery({
    queryKey: ["archived", workspaceId],
    queryFn: () => get<ChatSummary[]>(`/api/chats?workspaceId=${workspaceId}&archived=1`),
    enabled: !!workspaceId,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["archived", workspaceId] });
    qc.invalidateQueries({ queryKey: ["chats", workspaceId] });
    qc.invalidateQueries({ queryKey: ["project"] });
  };
  const restore = useMutation({
    mutationFn: (id: string) => patch(`/api/chats/${id}`, { archived: false }),
    onSuccess: () => {
      refresh();
      toast("Chat restored");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/api/chats/${id}`),
    onSuccess: () => {
      refresh();
      toast("Chat deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (archived.isLoading) return null;
  if (!archived.data?.length)
    return <p className="text-sm text-fg-subtle">No archived chats in {workspace?.name ?? "this workspace"}. Archive a chat from its menu to tidy your sidebar without deleting it.</p>;
  return (
    <Card className="divide-y divide-border">
      {archived.data.map((c) => (
        <div key={c.id} className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <Link href={c.projectId ? `/app/projects/${c.projectId}/${c.id}` : `/app/chat/${c.id}`} className="block truncate text-[13.5px] text-fg hover:underline">
              {c.title}
            </Link>
            <div className="text-xs text-fg-subtle">
              {c.projectName ? `${c.projectName} · ` : ""}archived {timeAgo(c.archivedAt ?? c.updatedAt)}
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => restore.mutate(c.id)}>
            <ArchiveRestore className="size-3.5" /> Restore
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={`Delete ${c.title}`} onClick={() => remove.mutate(c.id)}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
    </Card>
  );
}
