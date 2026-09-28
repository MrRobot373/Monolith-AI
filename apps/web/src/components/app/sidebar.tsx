"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronsUpDown,
  Code2,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings,
  Shield,
  SquarePen,
  Trash2,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { LogoMark } from "@/components/ui/logo";
import { Avatar, Badge, Kbd, Tooltip } from "@/components/ui/misc";
import { Dialog, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/overlay";
import { del, get, patch } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { ChatSummary } from "@/lib/types";
import { NotificationsButton } from "./notifications";
import { useSession } from "./session";

export function useChats(workspaceId: string) {
  return useQuery({
    queryKey: ["chats", workspaceId],
    queryFn: () => get<ChatSummary[]>(`/api/chats?workspaceId=${workspaceId}`),
    enabled: !!workspaceId,
  });
}

function groupChats(chats: ChatSummary[]) {
  const now = Date.now();
  const day = 86_400_000;
  const groups: { label: string; items: ChatSummary[] }[] = [
    { label: "Pinned", items: [] },
    { label: "Today", items: [] },
    { label: "Previous 7 days", items: [] },
    { label: "Older", items: [] },
  ];
  for (const c of chats) {
    const age = now - new Date(c.updatedAt).getTime();
    if (c.pinned) groups[0]!.items.push(c);
    else if (age < day) groups[1]!.items.push(c);
    else if (age < 7 * day) groups[2]!.items.push(c);
    else groups[3]!.items.push(c);
  }
  return groups.filter((g) => g.items.length);
}

export function Sidebar({ onCollapse }: { onCollapse: () => void }) {
  const { me, workspace, workspaceId, setWorkspaceId, signOut } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const chats = useChats(workspaceId);
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<ChatSummary | null>(null);
  const [newTitle, setNewTitle] = useState("");

  const filtered = useMemo(
    () => (chats.data ?? []).filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase())),
    [chats.data, query],
  );
  const groups = useMemo(() => groupChats(filtered), [filtered]);

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; title?: string; pinned?: boolean }) => patch(`/api/chats/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["chats", workspaceId] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/api/chats/${id}`),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["chats", workspaceId] });
      if (pathname === `/app/chat/${id}`) router.push("/app/chat");
      toast("Chat deleted");
    },
  });

  const sections = workspace?.sections ?? ["chat"];
  const nav = [
    { href: "/app/chat", label: "Chat", icon: MessageSquare, section: "chat" as const },
    { href: "/app/work", label: "Work AI", icon: Workflow, section: "work" as const, soon: true },
    { href: "/app/code", label: "Code", icon: Code2, section: "code" as const, soon: true },
  ].filter((n) => sections.includes(n.section) || me.isAdmin);

  return (
    <aside className="flex h-full w-full flex-col bg-bg-subtle">
      {/* Workspace switcher */}
      <div className="flex items-center gap-1 p-2">
        <Menu>
          <MenuTrigger asChild>
            <button className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2">
              <LogoMark className="size-6 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] leading-tight font-semibold">{workspace?.name ?? "No workspace"}</div>
                <div className="truncate text-[11px] leading-tight text-fg-subtle">{me.org.name}</div>
              </div>
              <ChevronsUpDown className="size-3.5 shrink-0 text-fg-subtle" />
            </button>
          </MenuTrigger>
          <MenuContent className="w-60">
            <MenuLabel>Workspaces</MenuLabel>
            {me.workspaces.map((w) => (
              <MenuItem
                key={w.id}
                onSelect={() => {
                  setWorkspaceId(w.id);
                  router.push("/app/chat");
                }}
                icon={<span className="flex size-4 items-center justify-center text-[11px]">{w.icon ?? "◆"}</span>}
                shortcut={w.id === workspaceId ? <Check className="size-3.5 text-accent" /> : null}
              >
                {w.name}
              </MenuItem>
            ))}
            {me.workspaces.length === 0 && <div className="px-2 py-1.5 text-xs text-fg-subtle">You aren&apos;t in any workspace yet.</div>}
          </MenuContent>
        </Menu>
        <Tooltip content={<span className="flex items-center gap-1.5">Collapse sidebar <Kbd>⌘</Kbd><Kbd>B</Kbd></span>}>
          <Button variant="ghost" size="icon-sm" onClick={onCollapse} aria-label="Collapse sidebar">
            <PanelLeftClose className="size-4" />
          </Button>
        </Tooltip>
      </div>

      {/* Sections */}
      <nav className="space-y-0.5 px-2 pt-1">
        {nav.map((n) => {
          const active = pathname.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                "group relative flex h-8 items-center gap-2.5 rounded-lg px-2 text-[13px] transition-colors",
                active ? "bg-surface-2 font-medium text-fg" : "text-fg-muted hover:bg-surface-2/60 hover:text-fg",
              )}
            >
              {active && <span className="absolute top-1.5 bottom-1.5 -left-2 w-[3px] rounded-r bg-accent" />}
              <n.icon className={cn("size-4", active ? "text-accent" : "text-fg-subtle group-hover:text-fg-muted")} />
              <span className="flex-1">{n.label}</span>
              {n.soon && <Badge className="h-4 px-1 text-[10px]">Soon</Badge>}
            </Link>
          );
        })}
      </nav>

      <div className="mt-3 flex items-center gap-1.5 px-2">
        <Button asChild variant="outline" size="sm" className="flex-1 justify-start">
          <Link href="/app/chat">
            <SquarePen className="size-3.5" /> New chat
          </Link>
        </Button>
      </div>

      {/* History */}
      <div className="mt-3 px-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="h-8 w-full rounded-lg bg-transparent pr-2 pl-8 text-[13px] placeholder:text-fg-subtle outline-none focus:bg-surface-2"
          />
        </div>
      </div>
      <div className="mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {chats.isLoading && (
          <div className="space-y-1.5 px-2 pt-3">
            {[70, 90, 60, 80].map((w) => (
              <div key={w} className="h-3 animate-pulse rounded bg-surface-2" style={{ width: `${w}%` }} />
            ))}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.label} className="mt-3">
            <div className="px-2 pb-1 text-[11px] font-medium text-fg-subtle">{g.label}</div>
            {g.items.map((c) => {
              const active = pathname === `/app/chat/${c.id}`;
              return (
                <div
                  key={c.id}
                  className={cn(
                    "group relative flex h-8 items-center rounded-lg transition-colors",
                    active ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface-2/60 hover:text-fg",
                  )}
                >
                  <Link href={`/app/chat/${c.id}`} className="min-w-0 flex-1 truncate px-2 text-[13px]">
                    {c.title}
                  </Link>
                  <Menu>
                    <MenuTrigger asChild>
                      <button
                        aria-label="Chat options"
                        className="mr-1 rounded-md p-1 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg focus:opacity-100 data-[state=open]:opacity-100"
                      >
                        <MoreHorizontal className="size-4" />
                      </button>
                    </MenuTrigger>
                    <MenuContent align="start" side="right" className="min-w-40">
                      <MenuItem icon={<Pencil />} onSelect={() => { setRenaming(c); setNewTitle(c.title); }}>Rename</MenuItem>
                      <MenuItem icon={c.pinned ? <PinOff /> : <Pin />} onSelect={() => update.mutate({ id: c.id, pinned: !c.pinned })}>
                        {c.pinned ? "Unpin" : "Pin"}
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem icon={<Trash2 />} danger onSelect={() => remove.mutate(c.id)}>Delete</MenuItem>
                    </MenuContent>
                  </Menu>
                </div>
              );
            })}
          </div>
        ))}
        {chats.data && chats.data.length === 0 && (
          <p className="px-2 pt-4 text-[12.5px] leading-relaxed text-fg-subtle">Your conversations will appear here.</p>
        )}
      </div>

      {/* Account */}
      <div className="flex items-center gap-1 border-t border-border p-2">
        <Menu>
          <MenuTrigger asChild>
            <button className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2">
              <Avatar name={me.user.name} image={me.user.image} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] leading-tight font-medium">{me.user.name}</div>
                <div className="truncate text-[11px] leading-tight text-fg-subtle">{me.user.email}</div>
              </div>
            </button>
          </MenuTrigger>
          <MenuContent side="top" className="w-56">
            <MenuItem icon={<Settings />} onSelect={() => router.push("/app/settings")}>Settings</MenuItem>
            {(me.isAdmin || me.isWorkspaceAdmin) && (
              <MenuItem icon={<Shield />} onSelect={() => router.push("/admin")}>Admin console</MenuItem>
            )}
            <MenuSeparator />
            <MenuItem icon={<LogOut />} onSelect={signOut}>Sign out</MenuItem>
          </MenuContent>
        </Menu>
        <NotificationsButton />
      </div>

      <Dialog
        open={!!renaming}
        onOpenChange={(o) => !o && setRenaming(null)}
        title="Rename chat"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (renaming && newTitle.trim()) update.mutate({ id: renaming.id, title: newTitle.trim() });
                setRenaming(null);
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <Input
          autoFocus
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && renaming && newTitle.trim()) {
              update.mutate({ id: renaming.id, title: newTitle.trim() });
              setRenaming(null);
            }
          }}
        />
      </Dialog>
    </aside>
  );
}
