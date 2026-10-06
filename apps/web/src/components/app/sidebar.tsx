"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Check,
  FolderInput,
  FolderOpen,
  Plus,
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
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Avatar, Kbd, Tooltip } from "@/components/ui/misc";
import { Dialog, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/overlay";
import { del, get, patch } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { ChatSummary } from "@/lib/types";
import { MoveToProjectDialog, NewProjectDialog, ProjectIcon, useProjects } from "@/components/projects/projects";
import { NotificationsButton } from "./notifications";
import { SearchPalette } from "./search-palette";
import { useSession } from "./session";
import { StatusIcon } from "@/components/work/parts";
import { usePendingApprovals, useWorkTasks } from "@/lib/work";

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

function SectionLabel({ children, open, onToggle, action }: { children: ReactNode; open?: boolean; onToggle?: () => void; action?: ReactNode }) {
  return (
    <div className="group/label flex h-7 items-center">
      <button
        type="button"
        onClick={onToggle}
        className="flex h-7 flex-1 items-center gap-1 px-2 text-[12px] text-fg-subtle transition-colors hover:text-fg-muted"
      >
        {children}
        {onToggle && <ChevronDown className={cn("size-3 transition-transform", !open && "-rotate-90")} />}
      </button>
      {action}
    </div>
  );
}

export function Sidebar({ onCollapse }: { onCollapse: () => void }) {
  const { me, workspace, workspaceId, setWorkspaceId, signOut } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const chats = useChats(workspaceId);
  const projects = useProjects(workspaceId);
  const [searchOpen, setSearchOpen] = useState(false);
  const [recentsOpen, setRecentsOpen] = useState(true);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [newProject, setNewProject] = useState(false);
  const [moving, setMoving] = useState<ChatSummary | null>(null);
  const [renaming, setRenaming] = useState<ChatSummary | null>(null);
  const [newTitle, setNewTitle] = useState("");

  // ⌘K / Ctrl+K opens search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const all = chats.data ?? [];
  const pinned = all.filter((c) => c.pinned);
  const recent = all.filter((c) => !c.pinned);

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; title?: string; pinned?: boolean; archived?: boolean }) => patch(`/api/chats/${id}`, body),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["chats", workspaceId] });
      if (v.archived !== undefined) qc.invalidateQueries({ queryKey: ["archived", workspaceId] });
      if (v.archived) {
        if (pathname === `/app/chat/${v.id}`) router.push("/app/chat");
        toast("Chat archived", { action: { label: "Undo", onClick: () => update.mutate({ id: v.id, archived: false }) } });
      }
    },
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
  const inWork = pathname.startsWith("/app/work");
  // A section shows when the license includes it and the person (or an admin) has it enabled.
  const can = (s: "chat" | "work" | "code") => (me.license?.sections.includes(s) ?? true) && (sections.includes(s) || me.isAdmin);
  const workTasks = useWorkTasks(can("work") ? workspaceId : "");
  const approvalsQ = usePendingApprovals(can("work") ? workspaceId : "");
  const pendingApprovals = approvalsQ.data?.length ?? 0;

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
            <MenuItem icon={<FolderInput />} onSelect={() => setMoving(c)}>Move to project</MenuItem>
            <MenuItem icon={<Archive />} onSelect={() => update.mutate({ id: c.id, archived: true })}>Archive</MenuItem>
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
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="flex h-8 w-full items-center gap-2 rounded-md border border-border bg-surface px-2 text-left transition-colors hover:border-border-strong"
          data-testid="open-search"
        >
          <Search className="size-3.5 shrink-0 text-fg-subtle" />
          <span className="min-w-0 flex-1 text-[13px] text-fg-subtle">Search</span>
          <span className="flex gap-0.5">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>
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
          <NavItem href="/app/projects" icon={<FolderOpen />} active={pathname === "/app/projects"}>
            Projects
          </NavItem>
        )}
        {can("chat") && (
          <NavItem href="/app/documents" icon={<FileText />} active={pathname.startsWith("/app/documents")}>
            Documents
          </NavItem>
        )}
        {can("work") && (
          <NavItem href="/app/work" icon={<Workflow />} active={pathname.startsWith("/app/work")} shortcut={pendingApprovals > 0 ? <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[10px] font-medium text-bg" aria-label={`${pendingApprovals} waiting for approval`}>{pendingApprovals}</span> : undefined}>
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
        {can("chat") && (
          <div className="mb-3">
            <SectionLabel
              open={projectsOpen}
              onToggle={() => setProjectsOpen((o) => !o)}
              action={
                <Tooltip content="New project">
                  <button
                    type="button"
                    aria-label="New project"
                    onClick={() => setNewProject(true)}
                    className="mr-1 rounded p-0.5 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg"
                  >
                    <Plus className="size-3.5" />
                  </button>
                </Tooltip>
              }
            >
              Projects
            </SectionLabel>
            {projectsOpen && (
              <div className="space-y-px">
                {(projects.data ?? []).slice(0, 8).map((p) => {
                  const active = pathname.startsWith(`/app/projects/${p.id}`);
                  return (
                    <Link
                      key={p.id}
                      href={`/app/projects/${p.id}`}
                      className={cn(
                        "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors",
                        active ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface-2/70 hover:text-fg",
                      )}
                    >
                      <ProjectIcon color={p.color} />
                      <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    </Link>
                  );
                })}
                {(projects.data?.length ?? 0) > 8 && (
                  <Link href="/app/projects" className="flex h-8 items-center px-2 text-[12.5px] text-fg-subtle hover:text-fg">
                    See all {projects.data!.length}
                  </Link>
                )}
                {projects.data?.length === 0 && (
                  <button
                    type="button"
                    onClick={() => setNewProject(true)}
                    className="flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] text-fg-subtle transition-colors hover:bg-surface-2/70 hover:text-fg"
                  >
                    <Plus className="size-4" /> New project
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {inWork ? (
          <div className="mb-3">
            <SectionLabel>Tasks</SectionLabel>
            <div className="space-y-px">
              {(workTasks.data ?? []).slice(0, 30).map((t) => {
                const active = pathname === `/app/work/${t.id}`;
                return (
                  <Link
                    key={t.id}
                    href={`/app/work/${t.id}`}
                    className={cn(
                      "flex h-8 items-center gap-2 rounded-md px-2 text-[13px] transition-colors",
                      active ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface-2/70 hover:text-fg",
                    )}
                  >
                    <StatusIcon status={t.status} className="size-3" />
                    <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  </Link>
                );
              })}
              {workTasks.data?.length === 0 && <p className="px-2 py-2 text-[12.5px] text-fg-subtle">Your tasks will appear here.</p>}
            </div>
          </div>
        ) : null}
        {!inWork && pinned.length > 0 && (
          <div className="mb-3">
            <SectionLabel>Pinned</SectionLabel>
            <div className="space-y-px">{pinned.map(chatRow)}</div>
          </div>
        )}
        {!inWork && (
        <SectionLabel open={recentsOpen} onToggle={() => setRecentsOpen((o) => !o)}>
          Recents
        </SectionLabel>
        )}
        {!inWork && recentsOpen && (
          <div className="space-y-px">
            {chats.isLoading &&
              [70, 90, 60].map((w) => (
                <div key={w} className="mx-2 my-2.5 h-2.5 animate-pulse rounded bg-surface-2" style={{ width: `${w}%` }} />
              ))}
            {recent.map(chatRow)}
            {chats.data && all.length === 0 && (
              <p className="px-2 py-2 text-[12.5px] text-fg-subtle">Your conversations will appear here.</p>
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

      <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} recents={all} />
      <NewProjectDialog open={newProject} onOpenChange={setNewProject} />
      <MoveToProjectDialog chat={moving} onOpenChange={(o) => !o && setMoving(null)} />
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
