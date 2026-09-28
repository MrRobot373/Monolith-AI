"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronsUpDown,
  Code2,
  FileText,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
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
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Avatar, Kbd, Tooltip } from "@/components/ui/misc";
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

/** Colourful rounded tile for a workspace, derived from its name (like an org avatar). */
export function WorkspaceTile({ name, className }: { name: string; icon?: string | null; className?: string }) {
  const hues = [190, 260, 330, 20, 140, 45, 210, 290];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const a = hues[h % hues.length]!;
  const b = hues[(h >> 3) % hues.length]!;
  return (
    <span
      className={cn("flex size-5 shrink-0 items-center justify-center rounded-md text-[10px] font-semibold text-white", className)}
      style={{ background: `linear-gradient(135deg, oklch(0.72 0.15 ${a}), oklch(0.6 0.17 ${b}))` }}
      aria-hidden
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function NavItem({
  href,
  icon,
  children,
  active,
  soon,
  shortcut,
}: {
  href: string;
  icon: ReactNode;
  children: ReactNode;
  active?: boolean;
  soon?: boolean;
  shortcut?: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors",
        active ? "bg-surface-2 text-fg" : soon ? "text-fg-subtle hover:bg-surface-2/70" : "text-fg-muted hover:bg-surface-2/70 hover:text-fg",
      )}
    >
      <span className={cn("[&>svg]:size-4", active ? "text-fg" : "text-fg-subtle")}>{icon}</span>
      <span className="flex-1 truncate">{children}</span>
      {soon && <span className="text-[11px] text-fg-subtle">Soon</span>}
      {shortcut}
    </Link>
  );
}

function SectionLabel({ children, open, onToggle }: { children: ReactNode; open?: boolean; onToggle?: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex h-7 w-full items-center gap-1 px-2 text-[12px] text-fg-subtle transition-colors hover:text-fg-muted"
    >
      {children}
      {onToggle && <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} />}
    </button>
  );
}

export function Sidebar({ onCollapse }: { onCollapse: () => void }) {
  const { me, workspace, workspaceId, setWorkspaceId, signOut } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const chats = useChats(workspaceId);
  const [query, setQuery] = useState("");
  const [recentsOpen, setRecentsOpen] = useState(true);
  const [renaming, setRenaming] = useState<ChatSummary | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // ⌘K / Ctrl+K focuses search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filtered = useMemo(
    () => (chats.data ?? []).filter((c) => c.title.toLowerCase().includes(query.trim().toLowerCase())),
    [chats.data, query],
  );
  const pinned = filtered.filter((c) => c.pinned);
  const recent = filtered.filter((c) => !c.pinned);

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
  const can = (s: "chat" | "work" | "code") => sections.includes(s) || me.isAdmin;

  const chatRow = (c: ChatSummary) => {
    const active = pathname === `/app/chat/${c.id}`;
    return (
      <div
        key={c.id}
        className={cn(
          "group relative flex h-8 items-center rounded-md transition-colors",
          active ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface-2/70 hover:text-fg",
        )}
      >
        <Link href={`/app/chat/${c.id}`} className="min-w-0 flex-1 truncate px-2 text-[13px]">
          {c.title}
        </Link>
        <Menu>
          <MenuTrigger asChild>
            <button
              aria-label="Chat options"
              className="mr-1 rounded p-0.5 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg focus:opacity-100 data-[state=open]:opacity-100"
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
  };

  return (
    <aside className="flex h-full w-full flex-col bg-bg-subtle">
      {/* Workspace switcher */}
      <div className="flex items-center gap-1 px-2 pt-2">
        <Menu>
          <MenuTrigger asChild>
            <button className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-surface px-2 text-left transition-colors hover:border-border-strong">
              <WorkspaceTile name={workspace?.name ?? me.org.name} icon={workspace?.icon} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{workspace?.name ?? "No workspace"}</span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-fg-subtle" />
            </button>
          </MenuTrigger>
          <MenuContent className="w-60">
            <MenuLabel>{me.org.name}</MenuLabel>
            {me.workspaces.map((w) => (
              <MenuItem
                key={w.id}
                onSelect={() => {
                  setWorkspaceId(w.id);
                  router.push("/app/chat");
                }}
                icon={<WorkspaceTile name={w.name} icon={w.icon} className="size-4 text-[9px]" />}
                shortcut={w.id === workspaceId ? <Check className="size-3.5" /> : null}
              >
                {w.name}
              </MenuItem>
            ))}
            {me.workspaces.length === 0 && <div className="px-2 py-1.5 text-xs text-fg-subtle">You aren&apos;t in any workspace yet.</div>}
          </MenuContent>
        </Menu>
        <Tooltip content={<span className="flex items-center gap-1.5">Hide sidebar <Kbd>⌘</Kbd><Kbd>B</Kbd></span>}>
          <Button variant="ghost" size="icon-sm" onClick={onCollapse} aria-label="Collapse sidebar">
            <PanelLeft className="size-4" />
          </Button>
        </Tooltip>
      </div>

      {/* Search */}
      <div className="px-2 pt-2">
        <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-surface px-2 transition-colors focus-within:border-border-strong">
          <Search className="size-3.5 shrink-0 text-fg-subtle" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-subtle"
          />
          <span className="flex gap-0.5">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </label>
      </div>

      {/* Primary nav */}
      <nav className="space-y-px px-2 pt-3">
        <NavItem href="/app/chat" icon={<SquarePen />} active={pathname === "/app/chat"}>
          New chat
        </NavItem>
        {can("chat") && (
          <NavItem href="/app/chat" icon={<MessageSquare />} active={pathname.startsWith("/app/chat/")}>
            Chat
          </NavItem>
        )}
        {can("chat") && (
          <NavItem href="/app/documents" icon={<FileText />} active={pathname.startsWith("/app/documents")}>
            Documents
          </NavItem>
        )}
        {can("work") && (
          <NavItem href="/app/work" icon={<Workflow />} active={pathname.startsWith("/app/work")} soon>
            Work AI
          </NavItem>
        )}
        {can("code") && (
          <NavItem href="/app/code" icon={<Code2 />} active={pathname.startsWith("/app/code")} soon>
            Code
          </NavItem>
        )}
      </nav>

      {/* Chats */}
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {pinned.length > 0 && (
          <div className="mb-3">
            <SectionLabel>Pinned</SectionLabel>
            <div className="space-y-px">{pinned.map(chatRow)}</div>
          </div>
        )}
        <SectionLabel open={recentsOpen} onToggle={() => setRecentsOpen((o) => !o)}>
          Recents
        </SectionLabel>
        {recentsOpen && (
          <div className="space-y-px">
            {chats.isLoading &&
              [70, 90, 60].map((w) => (
                <div key={w} className="mx-2 my-2.5 h-2.5 animate-pulse rounded bg-surface-2" style={{ width: `${w}%` }} />
              ))}
            {recent.map(chatRow)}
            {chats.data && filtered.length === 0 && (
              <p className="px-2 py-2 text-[12.5px] text-fg-subtle">{query ? "No chats match." : "Your conversations will appear here."}</p>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="space-y-px border-t border-border px-2 pt-2 pb-2">
        {(me.isAdmin || me.isWorkspaceAdmin) && (
          <NavItem href="/admin" icon={<Shield />}>
            Admin console
          </NavItem>
        )}
        <div className="flex items-center gap-1">
          <Menu>
            <MenuTrigger asChild>
              <button className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-surface-2">
                <Avatar name={me.user.name} image={me.user.image} className="size-5 text-[9px]" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{me.user.name}</span>
                <MoreHorizontal className="size-4 text-fg-subtle" />
              </button>
            </MenuTrigger>
            <MenuContent side="top" className="w-56">
              <MenuLabel>{me.user.email}</MenuLabel>
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
