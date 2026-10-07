"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Link2, MailWarning, MoreHorizontal, Search, ShieldCheck, ShieldOff, Smartphone, UserCheck, UserMinus, UserPlus, UsersRound, X } from "lucide-react";
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
  twoFactorEnabled: boolean;
  emailVerified: boolean;
  groups: { id: string; name: string }[];
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
  const [resetFor, setResetFor] = useState<UserRow | null>(null);
  const [twoStepFor, setTwoStepFor] = useState<UserRow | null>(null);

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
                  <span className="inline-flex items-center gap-1.5">
                    <Badge tone={u.orgRole === "member" ? "neutral" : "accent"}>{u.orgRole === "owner" ? "Owner" : u.orgRole === "admin" ? "Admin" : "Member"}</Badge>
                    {u.twoFactorEnabled && (
                      <span title="Two-step sign-in is on" className="inline-flex text-fg-subtle" data-testid="two-factor-badge">
                        <Smartphone className="size-3.5" />
                      </span>
                    )}
                    {!u.emailVerified && (
                      <span title="Email address not confirmed yet" className="inline-flex text-warning" data-testid="email-unconfirmed">
                        <MailWarning className="size-3.5" />
                      </span>
                    )}
                  </span>
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
                  {u.groups?.map((g) => (
                    <span key={g.id} title="Group" className="inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11.5px] text-fg-muted" data-testid="user-group">
                      <UsersRound className="size-3" />
                      {g.name}
                    </span>
                  ))}
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
                      {u.status === "active" && (
                        <MenuItem icon={<KeyRound />} onSelect={() => setResetFor(u)}>Send password reset link</MenuItem>
                      )}
                      {u.twoFactorEnabled && (
                        <MenuItem icon={<ShieldOff />} onSelect={() => setTwoStepFor(u)}>Turn off two-step sign-in</MenuItem>
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
      {resetFor && <ResetLinkDialog person={resetFor} onClose={() => setResetFor(null)} />}
      <Dialog
        open={!!twoStepFor}
        onOpenChange={(o) => !o && setTwoStepFor(null)}
        title={`Turn off two-step sign-in for ${twoStepFor?.name ?? ""}?`}
        description="Do this only if they lost their phone and backup codes. Their password alone will sign them in until they set it up again."
        footer={
          <>
            <Button variant="ghost" onClick={() => setTwoStepFor(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  await post(`/api/admin/users/${twoStepFor!.id}/two-factor/disable`);
                  toast.success(`Two-step sign-in is off for ${twoStepFor!.name}`);
                  qc.invalidateQueries({ queryKey: ["admin-users"] });
                } catch (e) {
                  toast.error((e as Error).message);
                }
                setTwoStepFor(null);
              }}
            >
              Turn off
            </Button>
          </>
        }
      />
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
  const [emailed, setEmailed] = useState(false);

  const reset = () => {
    setEmail("");
    setOrgRole("member");
    setSelected({});
    setLink(null);
    setEmailed(false);
  };

  const m = useMutation({
    mutationFn: () =>
      post<{ link: string; emailed: boolean }>("/api/admin/invites", {
        email,
        orgRole,
        workspaces: Object.entries(selected)
          .filter(([, r]) => r)
          .map(([workspaceId, role]) => ({ workspaceId, role })),
      }),
    onSuccess: (r) => {
      setLink(r.link);
      setEmailed(r.emailed);
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
      description={
        link
          ? emailed
            ? `We emailed the invitation to ${email}. You can also share this link. It works once and expires in 7 days.`
            : "Share this link with them. It works once and expires in 7 days."
          : "They'll set their own password when they accept."
      }
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
        <CopyLink link={link} />
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

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-subtle p-2 pl-3" data-testid="copy-link">
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
  );
}

/** A one-time link to choose a new password: emailed to the person when email is set up, otherwise shown here. */
function ResetLinkDialog({ person, onClose }: { person: UserRow; onClose: () => void }) {
  const send = useMutation({
    mutationFn: () => post<{ emailed: boolean; link?: string; email?: string; expiresInMinutes: number }>(`/api/admin/users/${person.id}/reset-link`),
    onError: (e: Error) => toast.error(e.message),
  });
  const r = send.data;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={r ? (r.emailed ? "Reset link sent" : "Reset link created") : `Reset ${person.name}'s password?`}
      description={
        r
          ? r.emailed
            ? `We emailed ${r.email} a link to choose a new password. It works once and expires in ${r.expiresInMinutes} minutes.`
            : `Email isn't set up, so share this link with ${person.name} yourself. It works once and expires in ${r.expiresInMinutes} minutes.`
          : `They'll get a one-time link to choose a new password, and be signed out on their devices once they do. Their password works until then.`
      }
      footer={
        r ? (
          <Button variant="primary" onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={send.isPending} onClick={() => send.mutate()} data-testid="send-reset-link">
              Create link
            </Button>
          </>
        )
      }
    >
      {r?.link && <CopyLink link={r.link} />}
    </Dialog>
  );
}
