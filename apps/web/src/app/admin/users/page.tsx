"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2, MoreHorizontal, Search, ShieldCheck, UserMinus, UserPlus, UserCheck, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Section, Table, Td } from "@/components/admin/table";
import { PageHeader } from "@/components/app/page-header";
import { useSession } from "@/components/app/session";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { Avatar, Badge, Card, EmptyState } from "@/components/ui/misc";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlay";
import { Skeleton } from "@/components/ui/spinner";
import { del, get, patch, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatTokens, timeAgo } from "@/lib/format";

interface UserRow {
  id: string;
  name: string;
  email: string;
  image: string | null;
  orgRole: "owner" | "admin" | "member";
  status: "active" | "deactivated";
  jobTitle: string | null;
  lastActiveAt: string | null;
  createdAt: string;
  tokensThisPeriod: number;
  workspaces: { workspaceId: string; name: string; role: "admin" | "member" }[];
}
interface InviteRow {
  id: string;
  email: string;
  orgRole: string;
  expiresAt: string;
  createdAt: string;
}
interface WorkspaceLite {
  id: string;
  name: string;
  icon: string | null;
}

export default function UsersPage() {
  const { me } = useSession();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["admin-users"], queryFn: () => get<UserRow[]>("/api/admin/users") });
  const invites = useQuery({ queryKey: ["admin-invites"], queryFn: () => get<InviteRow[]>("/api/admin/invites") });
  const [q, setQ] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);

  const filtered = useMemo(
    () => (users.data ?? []).filter((u) => `${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase())),
    [users.data, q],
  );

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; orgRole?: string; status?: string }) => patch(`/api/admin/users/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      toast.success("User updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => del(`/api/admin/invites/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-invites"] }),
  });

  return (
    <div className="space-y-8">
      <PageHeader
        title="Users"
        description="Everyone in your organization. Only org admins can invite new people."
        actions={
          <Button variant="primary" onClick={() => setInviteOpen(true)}>
            <UserPlus className="size-4" /> Invite people
          </Button>
        }
      />

      <div className="relative max-w-xs">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email" className="pl-9" />
      </div>

      {users.isLoading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : (
        <Table head={["Name", "Role", "Workspaces", "Tokens this period", "Last active", ""]}>
          {filtered.map((u) => (
            <tr key={u.id} className={cn("transition-colors hover:bg-surface-2/50", u.status === "deactivated" && "opacity-55")}>
              <Td>
                <div className="flex items-center gap-3">
                  <Avatar name={u.name} image={u.image} />
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {u.name} {u.id === me.user.id && <span className="text-xs font-normal text-fg-subtle">(you)</span>}
                    </div>
                    <div className="truncate text-xs text-fg-subtle">{u.email}</div>
                  </div>
                </div>
              </Td>
              <Td>
                {u.status === "deactivated" ? (
                  <Badge tone="danger">Deactivated</Badge>
                ) : (
                  <Badge tone={u.orgRole === "member" ? "neutral" : "accent"}>{u.orgRole === "owner" ? "Owner" : u.orgRole === "admin" ? "Admin" : "Member"}</Badge>
                )}
              </Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {u.workspaces.map((w) => (
                    <span key={w.workspaceId} className="rounded-md border border-border px-1.5 py-0.5 text-[11.5px] text-fg-muted">
                      {w.name}
                      {w.role === "admin" && <ShieldCheck className="ml-1 inline size-3 text-accent" />}
                    </span>
                  ))}
                  {u.workspaces.length === 0 && <span className="text-xs text-fg-subtle">None</span>}
                </div>
              </Td>
              <Td className="tabular-nums text-fg-muted">{formatTokens(u.tokensThisPeriod)}</Td>
              <Td className="text-fg-muted">{u.lastActiveAt ? timeAgo(u.lastActiveAt) : "Never"}</Td>
              <Td className="w-10 text-right">
                {u.orgRole !== "owner" && u.id !== me.user.id && (
                  <Menu>
                    <MenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${u.name}`}>
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </MenuTrigger>
                    <MenuContent align="end">
                      {u.orgRole === "member" ? (
                        <MenuItem icon={<ShieldCheck />} onSelect={() => update.mutate({ id: u.id, orgRole: "admin" })}>Make org admin</MenuItem>
                      ) : (
                        <MenuItem icon={<ShieldCheck />} onSelect={() => update.mutate({ id: u.id, orgRole: "member" })}>Remove admin role</MenuItem>
                      )}
                      <MenuSeparator />
                      {u.status === "active" ? (
                        <MenuItem icon={<UserMinus />} danger onSelect={() => update.mutate({ id: u.id, status: "deactivated" })}>Deactivate</MenuItem>
                      ) : (
                        <MenuItem icon={<UserCheck />} onSelect={() => update.mutate({ id: u.id, status: "active" })}>Reactivate</MenuItem>
                      )}
                    </MenuContent>
                  </Menu>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      <Section title="Pending invitations" description="Links expire after 7 days.">
        {invites.data?.length ? (
          <Card className="divide-y divide-border">
            {invites.data.map((i) => (
              <div key={i.id} className="flex items-center gap-3 px-4 py-3 text-sm">
                <Link2 className="size-4 text-fg-subtle" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{i.email}</div>
                  <div className="text-xs text-fg-subtle">
                    {i.orgRole} · sent {timeAgo(i.createdAt)} · expires {new Date(i.expiresAt).toLocaleDateString()}
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => revoke.mutate(i.id)}>
                  <X className="size-3.5" /> Revoke
                </Button>
              </div>
            ))}
          </Card>
        ) : (
          <Card>
            <EmptyState title="No pending invitations" description="Invite teammates and they'll appear here until they accept." className="py-8" />
          </Card>
        )}
      </Section>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  );
}

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const workspaces = useQuery({ queryKey: ["admin-workspaces"], queryFn: () => get<WorkspaceLite[]>("/api/admin/workspaces"), enabled: open });
  const [email, setEmail] = useState("");
  const [orgRole, setOrgRole] = useState<"member" | "admin">("member");
  const [selected, setSelected] = useState<Record<string, "member" | "admin" | undefined>>({});
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reset = () => {
    setEmail("");
    setOrgRole("member");
    setSelected({});
    setLink(null);
  };

  const m = useMutation({
    mutationFn: () =>
      post<{ link: string }>("/api/admin/invites", {
        email,
        orgRole,
        workspaces: Object.entries(selected)
          .filter(([, r]) => r)
          .map(([workspaceId, role]) => ({ workspaceId, role })),
      }),
    onSuccess: (r) => {
      setLink(r.link);
      qc.invalidateQueries({ queryKey: ["admin-invites"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setTimeout(reset, 200);
      }}
      title={link ? "Invitation created" : "Invite someone"}
      description={link ? "Share this link with them. It works once and expires in 7 days." : "They'll set their own password when they accept."}
      footer={
        link ? (
          <>
            <Button variant="ghost" onClick={reset}>Invite another</Button>
            <Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" loading={m.isPending} disabled={!email} onClick={() => m.mutate()}>Create invitation</Button>
          </>
        )
      }
    >
      {link ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-subtle p-2 pl-3">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">{link}</code>
          <Button
            size="sm"
            onClick={() => {
              navigator.clipboard.writeText(link);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="Email">
            <Input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
          </Field>
          <Field label="Organization role">
            <Select value={orgRole} onChange={(e) => setOrgRole(e.target.value as "member" | "admin")}>
              <option value="member">Member: uses the workspaces they're added to</option>
              <option value="admin">Admin: manages the whole organization</option>
            </Select>
          </Field>
          <Field label="Workspaces">
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border p-1">
              {workspaces.data?.map((w) => (
                <div key={w.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-2">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--accent)]"
                    checked={!!selected[w.id]}
                    onChange={(e) => setSelected((s) => ({ ...s, [w.id]: e.target.checked ? "member" : undefined }))}
                    id={`ws-${w.id}`}
                  />
                  <label htmlFor={`ws-${w.id}`} className="flex-1 text-sm">{w.name}</label>
                  {selected[w.id] && (
                    <select
                      value={selected[w.id]}
                      onChange={(e) => setSelected((s) => ({ ...s, [w.id]: e.target.value as "member" | "admin" }))}
                      className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs"
                    >
                      <option value="member">Member</option>
                      <option value="admin">Workspace admin</option>
                    </select>
                  )}
                </div>
              ))}
            </div>
          </Field>
        </div>
      )}
    </Dialog>
  );
}
