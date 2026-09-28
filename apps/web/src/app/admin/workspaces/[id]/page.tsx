"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Archive, MoreHorizontal, RotateCcw, ShieldCheck, UserMinus, UserPlus } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Section, Table, Td } from "@/components/admin/table";
import { useSession } from "@/components/app/session";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Avatar, Badge, Card, Meter, Switch } from "@/components/ui/misc";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlay";
import { Skeleton } from "@/components/ui/spinner";
import { del, get, patch, post, put } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatTokens } from "@/lib/format";
import type { WorkspaceRow } from "@/lib/types";

interface Member {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  status: string;
  orgRole: string;
  role: "admin" | "member";
  sections: string[];
  tokenLimit: number | null;
  used: number;
  effectiveLimit: number | null;
  isOverride: boolean;
}
interface ModelRow {
  id: string;
  displayName: string;
  providerName: string;
  enabled: boolean;
  sections: string[];
}

const TABS = ["Members", "Models", "Budget", "Settings"] as const;
const SECTION_LABELS: Record<string, string> = { chat: "Chat", work: "Work AI", code: "Code" };

export default function WorkspaceDetail() {
  const { id } = useParams<{ id: string }>();
  const { me } = useSession();
  const list = useQuery({ queryKey: ["admin-workspaces"], queryFn: () => get<WorkspaceRow[]>("/api/admin/workspaces") });
  const ws = list.data?.find((w) => w.id === id);
  const tabs = TABS.filter((t) => me.isAdmin || t === "Members");
  const [tab, setTab] = useState<(typeof TABS)[number]>("Members");

  if (list.isLoading) return <Skeleton className="h-64 rounded-xl" />;
  if (!ws) return <p className="text-sm text-fg-muted">Workspace not found.</p>;

  return (
    <div className="space-y-6">
      <Link href="/admin/workspaces" className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted transition-colors hover:text-fg">
        <ArrowLeft className="size-3.5" /> Workspaces
      </Link>
      <div className="flex items-center gap-3">
        <div className="flex size-11 items-center justify-center rounded-xl bg-surface-2 text-lg">{ws.icon ?? "◆"}</div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{ws.name}</h1>
          <p className="text-sm text-fg-muted">
            {ws.memberCount} members · {formatTokens(ws.used)} tokens used this period
          </p>
        </div>
      </div>
      <div className="flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cn("relative px-3 pb-2.5 text-sm transition-colors", tab === t ? "text-fg" : "text-fg-muted hover:text-fg")}>
            {t}
            {tab === t && <span className="absolute inset-x-2 -bottom-px h-px bg-fg" />}
          </button>
        ))}
      </div>
      <div key={tab} className="animate-rise">
        {tab === "Members" && <Members ws={ws} />}
        {tab === "Models" && <Models ws={ws} />}
        {tab === "Budget" && <Budget ws={ws} />}
        {tab === "Settings" && <Settings ws={ws} />}
      </div>
    </div>
  );
}

function Members({ ws }: { ws: WorkspaceRow }) {
  const qc = useQueryClient();
  const { me } = useSession();
  const members = useQuery({ queryKey: ["ws-members", ws.id], queryFn: () => get<Member[]>(`/api/admin/workspaces/${ws.id}/members`) });
  const [addOpen, setAddOpen] = useState(false);
  const [quotaFor, setQuotaFor] = useState<Member | null>(null);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["ws-members", ws.id] });
    qc.invalidateQueries({ queryKey: ["admin-workspaces"] });
    qc.invalidateQueries({ queryKey: ["me"] });
  };
  const update = useMutation({
    mutationFn: ({ userId, ...body }: { userId: string; role?: string; sections?: string[]; tokenLimit?: number | null }) =>
      patch(`/api/admin/workspaces/${ws.id}/members/${userId}`, body),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => del(`/api/admin/workspaces/${ws.id}/members/${userId}`),
    onSuccess: invalidate,
  });

  return (
    <Section
      title="Members"
      description={
        ws.tokenLimit === null
          ? "This workspace has no token budget, so members are unlimited."
          : `Default allowance: the ${formatTokens(ws.tokenLimit)} budget split evenly. You can override it for anyone.`
      }
      actions={
        <Button variant="primary" size="sm" onClick={() => setAddOpen(true)}>
          <UserPlus className="size-3.5" /> Add member
        </Button>
      }
    >
      {members.isLoading ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : (
        <Table head={["Member", "Role", "Sections", "Usage this period", ""]}>
          {members.data?.map((m) => (
            <tr key={m.userId} className="hover:bg-surface-2/50">
              <Td>
                <div className="flex items-center gap-3">
                  <Avatar name={m.name} image={m.image} />
                  <div className="min-w-0">
                    <div className="truncate font-medium">{m.name}</div>
                    <div className="truncate text-xs text-fg-subtle">{m.email}</div>
                  </div>
                </div>
              </Td>
              <Td>{m.role === "admin" ? <Badge tone="accent">Workspace admin</Badge> : <Badge>Member</Badge>}</Td>
              <Td>
                <div className="flex gap-1">
                  {(["chat", "work", "code"] as const).map((s) => {
                    const on = m.sections.includes(s);
                    return (
                      <button
                        key={s}
                        onClick={() =>
                          update.mutate({ userId: m.userId, sections: on ? m.sections.filter((x) => x !== s) : [...m.sections, s] })
                        }
                        className={cn(
                          "rounded-md border px-1.5 py-0.5 text-[11.5px] transition-colors",
                          on ? "border-border-strong bg-surface-3 text-fg" : "border-border text-fg-subtle hover:text-fg-muted",
                        )}
                      >
                        {SECTION_LABELS[s]}
                      </button>
                    );
                  })}
                </div>
              </Td>
              <Td className="min-w-48">
                <div className="flex justify-between text-xs">
                  <span className="tabular-nums">{formatTokens(m.used)}</span>
                  <span className="text-fg-subtle">
                    {m.effectiveLimit === null ? "Unlimited" : `of ${formatTokens(m.effectiveLimit)}`}
                    {m.isOverride && " · custom"}
                  </span>
                </div>
                <Meter className="mt-1.5" value={m.effectiveLimit ? m.used / m.effectiveLimit : null} />
              </Td>
              <Td className="w-10 text-right">
                <Menu>
                  <MenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label="Member actions">
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </MenuTrigger>
                  <MenuContent align="end">
                    <MenuItem icon={<ShieldCheck />} onSelect={() => update.mutate({ userId: m.userId, role: m.role === "admin" ? "member" : "admin" })}>
                      {m.role === "admin" ? "Make member" : "Make workspace admin"}
                    </MenuItem>
                    <MenuItem icon={<RotateCcw />} onSelect={() => setQuotaFor(m)}>Set token allowance</MenuItem>
                    <MenuSeparator />
                    <MenuItem icon={<UserMinus />} danger disabled={m.userId === me.user.id} onSelect={() => remove.mutate(m.userId)}>
                      Remove from workspace
                    </MenuItem>
                  </MenuContent>
                </Menu>
              </Td>
            </tr>
          ))}
        </Table>
      )}
      <AddMemberDialog open={addOpen} onOpenChange={setAddOpen} ws={ws} existing={members.data?.map((m) => m.userId) ?? []} onAdded={invalidate} />
      {quotaFor && (
        <QuotaDialog
          member={quotaFor}
          onClose={() => setQuotaFor(null)}
          onSave={(tokenLimit) => {
            update.mutate({ userId: quotaFor.userId, tokenLimit });
            setQuotaFor(null);
            toast.success("Allowance updated");
          }}
        />
      )}
    </Section>
  );
}

function AddMemberDialog({ open, onOpenChange, ws, existing, onAdded }: { open: boolean; onOpenChange: (o: boolean) => void; ws: WorkspaceRow; existing: string[]; onAdded: () => void }) {
  const { me } = useSession();
  const users = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => get<{ id: string; name: string; email: string; status: string }[]>("/api/admin/users"),
    enabled: open && me.isAdmin,
  });
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const candidates = (users.data ?? []).filter((u) => u.status === "active" && !existing.includes(u.id));
  const add = useMutation({
    mutationFn: () => post(`/api/admin/workspaces/${ws.id}/members`, { userId, role, sections: ["chat", "work", "code"] }),
    onSuccess: () => {
      onAdded();
      onOpenChange(false);
      setUserId("");
      toast.success("Member added");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Add to ${ws.name}`}
      description="Choose someone who is already in your organization. Org admins invite new people from Users."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!userId} loading={add.isPending} onClick={() => add.mutate()}>Add member</Button>
        </>
      }
    >
      {me.isAdmin ? (
        <div className="space-y-4">
          <Field label="Person">
            <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Select…</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
              <option value="member">Member</option>
              <option value="admin">Workspace admin</option>
            </Select>
          </Field>
        </div>
      ) : (
        <Field label="User ID" hint="Ask an org admin for the person's ID, or ask them to add the member.">
          <Input value={userId} onChange={(e) => setUserId(e.target.value)} />
        </Field>
      )}
    </Dialog>
  );
}

function QuotaDialog({ member, onClose, onSave }: { member: Member; onClose: () => void; onSave: (v: number | null) => void }) {
  const [mode, setMode] = useState<"default" | "custom">(member.isOverride ? "custom" : "default");
  const [value, setValue] = useState(member.tokenLimit ? String(member.tokenLimit / 1000) : "");
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Token allowance for ${member.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => onSave(mode === "default" ? null : Math.round(Number(value || 0) * 1000))}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        {(["default", "custom"] as const).map((m) => (
          <label key={m} className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors", mode === m ? "border-fg-subtle bg-surface-2" : "border-border")}>
            <input type="radio" className="mt-1 accent-[var(--fg)]" checked={mode === m} onChange={() => setMode(m)} />
            <div className="flex-1">
              <div className="text-sm font-medium">{m === "default" ? "Workspace default" : "Custom allowance"}</div>
              <div className="text-xs text-fg-muted">
                {m === "default" ? "An even share of the workspace budget, recalculated as members change." : "A fixed allowance for this person each period."}
              </div>
              {m === "custom" && mode === "custom" && (
                <div className="mt-2 flex items-center gap-2">
                  <Input autoFocus inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ""))} className="w-32" />
                  <span className="text-xs text-fg-muted">thousand tokens</span>
                </div>
              )}
            </div>
          </label>
        ))}
      </div>
    </Dialog>
  );
}

function Models({ ws }: { ws: WorkspaceRow }) {
  const qc = useQueryClient();
  const all = useQuery({ queryKey: ["admin-models"], queryFn: () => get<ModelRow[]>("/api/admin/models") });
  const current = useQuery({ queryKey: ["ws-models", ws.id], queryFn: () => get<{ modelIds: string[]; defaultModelId: string | null }>(`/api/admin/workspaces/${ws.id}/models`) });
  const [ids, setIds] = useState<string[]>([]);
  const [def, setDef] = useState<string | null>(null);
  useEffect(() => {
    if (current.data) {
      setIds(current.data.modelIds);
      setDef(current.data.defaultModelId);
    }
  }, [current.data]);
  const save = useMutation({
    mutationFn: () => put(`/api/admin/workspaces/${ws.id}/models`, { modelIds: ids, defaultModelId: def }),
    onSuccess: () => {
      toast.success("Models updated");
      qc.invalidateQueries({ queryKey: ["ws-models", ws.id] });
      qc.invalidateQueries({ queryKey: ["admin-workspaces"] });
      qc.invalidateQueries({ queryKey: ["models"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const dirty = current.data && (JSON.stringify([...ids].sort()) !== JSON.stringify([...current.data.modelIds].sort()) || def !== current.data.defaultModelId);
  return (
    <Section
      title="Models in this workspace"
      description="Members can choose from these. Add models to the organization under Models."
      actions={<Button variant="primary" size="sm" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>Save changes</Button>}
    >
      <Card className="divide-y divide-border">
        {all.data?.map((m) => {
          const on = ids.includes(m.id);
          return (
            <div key={m.id} className="flex items-center gap-4 px-4 py-3">
              <Switch checked={on} onCheckedChange={(v) => setIds((s) => (v ? [...s, m.id] : s.filter((x) => x !== m.id)))} label={`Enable ${m.displayName}`} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {m.displayName} {!m.enabled && <Badge tone="warning">Disabled org-wide</Badge>}
                </div>
                <div className="text-xs text-fg-subtle">{m.providerName} · {m.sections.map((s) => SECTION_LABELS[s]).join(", ")}</div>
              </div>
              {on && (
                <button
                  onClick={() => setDef(m.id)}
                  className={cn("rounded-md border px-2 py-1 text-xs transition-colors", def === m.id ? "border-border-strong bg-surface-3 text-fg" : "border-border text-fg-subtle hover:text-fg")}
                >
                  {def === m.id ? "Default" : "Make default"}
                </button>
              )}
            </div>
          );
        })}
        {all.data?.length === 0 && <p className="px-4 py-8 text-center text-sm text-fg-subtle">No models in the organization yet.</p>}
      </Card>
    </Section>
  );
}

function Budget({ ws }: { ws: WorkspaceRow }) {
  const qc = useQueryClient();
  const [unlimited, setUnlimited] = useState(ws.tokenLimit === null);
  const [value, setValue] = useState(ws.tokenLimit ? String(ws.tokenLimit / 1_000_000) : "10");
  const save = useMutation({
    mutationFn: () => put(`/api/admin/workspaces/${ws.id}/budget`, { tokenLimit: unlimited ? null : Math.round(Number(value) * 1_000_000) }),
    onSuccess: () => {
      toast.success("Budget saved");
      qc.invalidateQueries({ queryKey: ["admin-workspaces"] });
      qc.invalidateQueries({ queryKey: ["ws-members", ws.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const perMember = !unlimited && ws.memberCount ? (Number(value) * 1_000_000) / ws.memberCount : null;
  return (
    <Section title="Token budget" description="The total tokens this workspace can use each period. The period is set in Settings.">
      <Card className="space-y-5 p-5">
        <label className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">Limit this workspace</div>
            <div className="text-xs text-fg-muted">When off, members can use models without a cap.</div>
          </div>
          <Switch checked={!unlimited} onCheckedChange={(v) => setUnlimited(!v)} label="Limit this workspace" />
        </label>
        {!unlimited && (
          <div className="flex flex-wrap items-end gap-4">
            <Field label="Budget per period">
              <div className="flex items-center gap-2">
                <Input inputMode="decimal" className="w-32" value={value} onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ""))} />
                <span className="text-sm text-fg-muted">million tokens</span>
              </div>
            </Field>
            {perMember !== null && (
              <p className="pb-2 text-sm text-fg-muted">
                ≈ <span className="text-fg">{formatTokens(perMember)}</span> per member by default ({ws.memberCount} members)
              </p>
            )}
          </div>
        )}
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save budget</Button>
      </Card>
    </Section>
  );
}

function Settings({ ws }: { ws: WorkspaceRow }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState(ws.name);
  const [confirm, setConfirm] = useState(false);
  const save = useMutation({
    mutationFn: () => patch(`/api/admin/workspaces/${ws.id}`, { name }),
    onSuccess: () => {
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["admin-workspaces"] });
      qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
  const archive = useMutation({
    mutationFn: () => del(`/api/admin/workspaces/${ws.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-workspaces"] });
      qc.invalidateQueries({ queryKey: ["me"] });
      router.push("/admin/workspaces");
      toast("Workspace archived");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="space-y-8">
      <Section title="General">
        <Card className="space-y-4 p-5">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} className="max-w-sm" />
          </Field>
          <Button variant="primary" disabled={name === ws.name || !name.trim()} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </Card>
      </Section>
      <Section title="Archive workspace">
        <Card className="flex flex-wrap items-center justify-between gap-4 border-danger/30 p-5">
          <p className="max-w-md text-sm text-fg-muted">Members lose access. Chats and usage history are kept for audit.</p>
          <Button variant="outline" className="text-danger" onClick={() => setConfirm(true)}>
            <Archive className="size-4" /> Archive
          </Button>
        </Card>
      </Section>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Archive ${ws.name}?`}
        description="Members will no longer see this workspace."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" loading={archive.isPending} onClick={() => archive.mutate()}>Archive workspace</Button>
          </>
        }
      />
    </div>
  );
}
