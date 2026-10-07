"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  BookmarkCheck,
  CalendarClock,
  Check,
  FileUp,
  History,
  RotateCcw,
  Tag,
  CircleAlert,
  FileText,
  Globe,
  Library,
  Loader2,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Settings2,
  Share2,
  StickyNote,
  Trash2,
  Upload,
  Users,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { TopBar } from "@/components/app/frame";
import { useCanUse, useSession } from "@/components/app/session";
import { StatusIcon } from "@/components/work/parts";
import { ChatView } from "@/components/chat/chat-view";
import { ACCEPT, FileIcon, useDocuments } from "@/components/documents/use-documents";
import {
  ProjectIcon,
  ProjectSettingsDialog,
  ShareProjectDialog,
  uploadProjectSource,
  useProject,
} from "@/components/projects/projects";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { Avatar } from "@/components/ui/misc";
import { LabelBadge, LABELS } from "@/components/chat/citations";
import { Dialog, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/overlay";
import { Skeleton } from "@/components/ui/spinner";
import { del, formatBytes, patch, post } from "@/lib/api";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import type { ProjectDetail, ProjectSource, SourceLabel } from "@/lib/types";

/** /app/projects/:id (project home + new chat) and /app/projects/:id/:chatId (a chat in the project). */
export default function ProjectPage() {
  const projectId = useParams<{ id: string }>().id;
  // Read the chat id from the pathname: it follows history.replaceState, while route params don't.
  const paramChat = usePathname().split("/")[4] || undefined;
  const project = useProject(projectId);
  const [localId, setLocalId] = useState<string | null>(null);
  const [fresh, setFresh] = useState(0);
  const prevParam = useRef(paramChat);

  useEffect(() => {
    if (prevParam.current && !paramChat) {
      setLocalId(null);
      setFresh((n) => n + 1);
    }
    prevParam.current = paramChat;
  }, [paramChat]);

  if (project.error) {
    return (
      <div className="flex h-full flex-col">
        <TopBar title="Project" />
        <div className="flex flex-1 items-center justify-center text-[13px] text-fg-subtle">This project doesn&apos;t exist or you no longer have access.</div>
      </div>
    );
  }
  if (!project.data) {
    return (
      <div className="flex h-full flex-col">
        <TopBar title={<Skeleton className="h-3.5 w-32" />} />
        <div className="mx-auto w-full max-w-3xl space-y-4 px-6 pt-16">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-28 w-full rounded-2xl" />
        </div>
      </div>
    );
  }
  const p = project.data;
  const isLocal = !paramChat || paramChat === localId;
  return (
    <Suspense>
      <ChatView
        key={isLocal ? `new-${projectId}-${fresh}` : paramChat}
        chatId={isLocal ? undefined : paramChat}
        project={{ id: p.id, name: p.name, color: p.color, canEdit: p.canEdit }}
        onCreated={(id) => {
          setLocalId(id);
          window.history.replaceState(null, "", `/app/projects/${projectId}/${id}`);
        }}
        renderHome={({ composer, notices }) => <ProjectHome project={p} composer={composer} notices={notices} />}
      />
    </Suspense>
  );
}

function ProjectHome({ project: p, composer, notices }: { project: ProjectDetail; composer: ReactNode; notices: ReactNode }) {
  const { me, workspaceId } = useSession();
  const router = useRouter();
  const qc = useQueryClient();
  const [sharing, setSharing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isMember = p.members.some((m) => m.userId === me.user.id);
  const canWork = useCanUse("work");

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ["projects", workspaceId] });
    qc.invalidateQueries({ queryKey: ["chats", workspaceId] });
  };
  const remove = useMutation({
    mutationFn: () => del(`/api/projects/${p.id}`),
    onSuccess: () => {
      refreshAll();
      toast(`Deleted ${p.name}`);
      router.push("/app/projects");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const leave = useMutation({
    mutationFn: () => del(`/api/projects/${p.id}/members/${me.user.id}`),
    onSuccess: () => {
      refreshAll();
      toast(`You left ${p.name}`);
      router.push("/app/projects");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const sharedCount = p.members.length + (p.visibility === "workspace" ? 1 : 0);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 pt-10 pb-12 sm:px-8 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <div className="flex items-start gap-3">
            <span className="mt-1 flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-surface">
              <ProjectIcon color={p.color} className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="truncate font-serif text-[30px] leading-tight tracking-[-0.02em]" data-testid="project-title">{p.name}</h1>
              <p className="mt-0.5 text-[13px] text-fg-subtle">
                {p.description || (p.role === "owner" ? "Your project" : `${p.owner?.name ?? "Someone"}'s project`)}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="outline" size="sm" onClick={() => setSharing(true)}>
                {p.visibility === "workspace" ? <Globe className="size-3.5" /> : <Share2 className="size-3.5" />}
                {sharedCount > 0 ? "Shared" : "Share"}
              </Button>
              <Menu>
                <MenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Project options">
                    <MoreHorizontal className="size-4" />
                  </Button>
                </MenuTrigger>
                <MenuContent align="end">
                  {p.canEdit && <MenuItem icon={<Settings2 />} onSelect={() => setEditing(true)}>Project settings</MenuItem>}
                  <MenuItem icon={<Users />} onSelect={() => setSharing(true)}>People</MenuItem>
                  {isMember && p.role !== "owner" && (
                    <MenuItem icon={<LogOut />} onSelect={() => leave.mutate()}>Leave project</MenuItem>
                  )}
                  {(p.role === "owner" || me.isAdmin || me.isWorkspaceAdmin) && (
                    <>
                      <MenuSeparator />
                      <MenuItem icon={<Trash2 />} danger onSelect={() => setConfirmDelete(true)}>Delete project</MenuItem>
                    </>
                  )}
                </MenuContent>
              </Menu>
            </div>
          </div>

          <div className="mt-6">
            {notices}
            {composer}
          </div>

          <section className="mt-8">
            <h2 className="mb-2 text-[13px] text-fg">
              Chats <span className="text-fg-subtle">({p.chats.length})</span>
            </h2>
            {p.chats.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-[13px] text-fg-subtle">
                Chats you start here stay in this project and can use its files and each other.
              </div>
            ) : (
              <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface" data-testid="project-chats">
                {p.chats.map((c) => (
                  <Link
                    key={c.id}
                    href={`/app/projects/${p.id}/${c.id}`}
                    className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/50"
                  >
                    <MessageSquare className="size-3.5 shrink-0 text-fg-subtle" />
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">{c.title}</span>
                    {c.userId !== me.user.id ? (
                      <span className="shrink-0 text-[12px] text-fg-subtle">Shared by {c.userName}</span>
                    ) : c.sharedToProject ? (
                      <span className="shrink-0 text-[12px] text-fg-subtle">Shared</span>
                    ) : null}
                    <span className="w-16 shrink-0 text-right text-[12px] text-fg-subtle">{timeAgo(c.updatedAt)}</span>
                  </Link>
                ))}
              </div>
            )}
          </section>

          {canWork && (
            <section className="mt-8">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-[13px] text-fg">
                  Tasks <span className="text-fg-subtle">({p.tasks.length})</span>
                </h2>
                <Button variant="outline" size="sm" onClick={() => router.push(`/app/work?project=${p.id}`)} data-testid="project-new-task">
                  <Workflow className="size-3.5" /> New task
                </Button>
              </div>
              {p.tasks.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-[13px] text-fg-subtle">
                  Work AI tasks started here follow the project&apos;s instructions, get a copy of its files and can save results back to it.
                </div>
              ) : (
                <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface" data-testid="project-tasks">
                  {p.tasks.map((t) => (
                    <Link key={t.id} href={`/app/work/${t.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/50">
                      <StatusIcon status={t.status} />
                      <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">{t.title}</span>
                      {t.scheduleId && <CalendarClock className="size-3.5 shrink-0 text-fg-subtle" aria-label="Scheduled" />}
                      {t.userId !== me.user.id ? (
                        <span className="shrink-0 text-[12px] text-fg-subtle">Shared by {t.userName}</span>
                      ) : t.sharedToProject ? (
                        <span className="shrink-0 text-[12px] text-fg-subtle">Shared</span>
                      ) : null}
                      <span className="w-16 shrink-0 text-right text-[12px] text-fg-subtle">{timeAgo(t.updatedAt)}</span>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>

        <aside className="space-y-4">
          <InstructionsCard project={p} onEdit={() => setEditing(true)} />
          <SourcesCard project={p} />
          <PeopleCard project={p} onOpen={() => setSharing(true)} />
        </aside>
      </div>

      <ShareProjectDialog project={p} open={sharing} onOpenChange={setSharing} />
      <ProjectSettingsDialog project={p} open={editing} onOpenChange={setEditing} />
      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${p.name}?`}
        description="All chats in this project and the files added only to it are deleted. Documents linked from the library stay in the library. This can't be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Delete project</Button>
          </>
        }
      />
    </div>
  );
}

function Panel({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface">
      <div className="flex h-10 items-center justify-between gap-2 border-b border-border px-3.5">
        <h3 className="text-[13px] text-fg">{title}</h3>
        {action}
      </div>
      <div className="p-3.5">{children}</div>
    </section>
  );
}

function InstructionsCard({ project: p, onEdit }: { project: ProjectDetail; onEdit: () => void }) {
  return (
    <Panel
      title="Instructions"
      action={
        p.canEdit && (
          <Button variant="ghost" size="sm" onClick={onEdit} className="-mr-1.5">
            {p.instructions ? "Edit" : "Add"}
          </Button>
        )
      }
    >
      {p.instructions ? (
        <p className="line-clamp-6 text-[12.5px] leading-relaxed whitespace-pre-wrap text-fg-muted" data-testid="instructions-preview">
          {p.instructions}
        </p>
      ) : (
        <p className="text-[12.5px] leading-relaxed text-fg-subtle">
          Tell the assistant how to work in this project: tone, format, background. They replace personal instructions here.
        </p>
      )}
    </Panel>
  );
}

function SourceIcon({ s }: { s: ProjectSource }) {
  if (s.kind === "answer") return <BookmarkCheck className="size-4 shrink-0 text-fg-subtle" />;
  if (s.kind === "note") return <StickyNote className="size-4 shrink-0 text-fg-subtle" />;
  return <FileIcon name={s.name} />;
}

function SourcesCard({ project: p }: { project: ProjectDetail }) {
  const { workspaceId } = useSession();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const [noteOpen, setNoteOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [superseding, setSuperseding] = useState<ProjectSource | null>(null);
  const versionRef = useRef<HTMLInputElement>(null);
  const replacing = useRef<string | null>(null);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const library = useDocuments(libraryOpen ? workspaceId : "");
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["project", p.id] });
    qc.invalidateQueries({ queryKey: ["projects", workspaceId] });
  };

  async function uploadFiles(files: FileList | File[]) {
    for (const f of Array.from(files)) {
      setUploading((u) => [...u, f.name]);
      try {
        await uploadProjectSource(p.id, f);
        refresh();
      } catch (e) {
        toast.error(`${f.name}: ${(e as Error).message}`);
      } finally {
        setUploading((u) => u.filter((n) => n !== f.name));
      }
    }
  }
  const addNote = useMutation({
    mutationFn: () => post(`/api/projects/${p.id}/sources/note`, { title: noteTitle.trim(), content: noteBody }),
    onSuccess: () => {
      refresh();
      setNoteOpen(false);
      setNoteTitle("");
      setNoteBody("");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const link = useMutation({
    mutationFn: (documentId: string) => post(`/api/projects/${p.id}/sources/link`, { documentId }),
    onSuccess: () => refresh(),
    onError: (e) => toast.error((e as Error).message),
  });
  const updateSource = useMutation({
    mutationFn: ({ id, ...body }: { id: string; label?: SourceLabel | null; supersededById?: string | null }) =>
      patch(`/api/projects/${p.id}/sources/${id}`, body),
    onSuccess: () => refresh(),
    onError: (e) => toast.error((e as Error).message),
  });
  async function uploadVersion(file: File) {
    const old = replacing.current;
    replacing.current = null;
    if (!old) return;
    setUploading((u) => [...u, file.name]);
    try {
      await uploadProjectSource(p.id, file, old);
      refresh();
      toast("New version added. The old one is kept but no longer used in answers.");
    } catch (e) {
      toast.error(`${file.name}: ${(e as Error).message}`);
    } finally {
      setUploading((u) => u.filter((n) => n !== file.name));
    }
  }
  const remove = useMutation({
    mutationFn: (documentId: string) => del(`/api/projects/${p.id}/sources/${documentId}`),
    onSuccess: () => refresh(),
    onError: (e) => toast.error((e as Error).message),
  });
  const linkable = useMemo(() => (library.data ?? []).filter((d) => !p.sources.some((s) => s.id === d.id)), [library.data, p.sources]);

  return (
    <Panel
      title={
        <span>
          Sources <span className="text-fg-subtle">({p.sources.length})</span>
        </span>
      }
      action={
        p.canEdit && (
          <Menu>
            <MenuTrigger asChild>
              <Button variant="ghost" size="sm" className="-mr-1.5" aria-label="Add source">
                <Plus className="size-3.5" /> Add
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem icon={<Upload />} onSelect={() => inputRef.current?.click()}>Upload files</MenuItem>
              <MenuItem icon={<StickyNote />} onSelect={() => setNoteOpen(true)}>Add text</MenuItem>
              <MenuItem icon={<Library />} onSelect={() => setLibraryOpen(true)}>From your documents</MenuItem>
            </MenuContent>
          </Menu>
        )
      }
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        data-testid="project-upload"
        onChange={(e) => {
          if (e.target.files?.length) uploadFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={versionRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        data-testid="version-upload"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void uploadVersion(f);
          e.target.value = "";
        }}
      />
      <div className="-mx-1.5 space-y-px" data-testid="project-sources">
        {uploading.map((n) => (
          <div key={n} className="flex h-8 items-center gap-2 px-1.5 text-[12.5px] text-fg-muted">
            <Loader2 className="size-4 animate-spin text-fg-subtle" />
            <span className="min-w-0 flex-1 truncate">{n}</span>
          </div>
        ))}
        {p.sources.map((s) => {
          const newer = s.supersededById ? p.sources.find((x) => x.id === s.supersededById) : undefined;
          return (
            <div
              key={s.id}
              className={cn("group flex h-8 items-center gap-2 rounded-md px-1.5 hover:bg-surface-2/60", s.supersededById && "opacity-60")}
              data-testid="source-row"
            >
              <SourceIcon s={s} />
              <a
                href={`/api/documents/${s.id}/file`}
                className={cn("min-w-0 flex-1 truncate text-[12.5px] text-fg-muted hover:text-fg", s.supersededById && "line-through")}
                title={newer ? `${s.name}, replaced by ${newer.name}` : s.name}
              >
                {s.name}
              </a>
              {s.supersededById && <span className="shrink-0 text-[10.5px] text-fg-subtle">Old version</span>}
              <LabelBadge label={s.label} />
              {s.status === "processing" ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-fg-subtle" aria-label="Processing" />
              ) : s.status === "failed" ? (
                <CircleAlert className="size-3.5 shrink-0 text-danger" aria-label={s.error ?? "Failed"} />
              ) : (
                !s.label &&
                !s.supersededById && (
                  <span className={cn("shrink-0 text-[11px] text-fg-subtle", p.canEdit && "group-hover:hidden")}>
                    {!s.projectOnly ? "Library" : s.kind === "file" ? formatBytes(s.sizeBytes) : s.kind === "answer" ? "Answer" : "Text"}
                  </span>
                )
              )}
              {p.canEdit && (
                <Menu>
                  <MenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={`Options for ${s.name}`}
                      className="hidden shrink-0 rounded p-0.5 text-fg-subtle group-hover:block hover:text-fg data-[state=open]:block"
                    >
                      <MoreHorizontal className="size-3.5" />
                    </button>
                  </MenuTrigger>
                  <MenuContent align="end" className="min-w-52">
                    <MenuLabel>Label</MenuLabel>
                    {(["confirmed", "assumption", "tbd"] as const).map((l) => (
                      <MenuItem
                        key={l}
                        icon={<Tag />}
                        shortcut={s.label === l ? <Check className="size-3.5" /> : undefined}
                        onSelect={() => updateSource.mutate({ id: s.id, label: s.label === l ? null : l })}
                      >
                        {LABELS[l].text}
                      </MenuItem>
                    ))}
                    <MenuSeparator />
                    {s.kind === "file" && s.projectOnly && (
                      <MenuItem
                        icon={<FileUp />}
                        onSelect={() => {
                          replacing.current = s.id;
                          versionRef.current?.click();
                        }}
                      >
                        Upload new version
                      </MenuItem>
                    )}
                    {s.supersededById ? (
                      <MenuItem icon={<RotateCcw />} onSelect={() => updateSource.mutate({ id: s.id, supersededById: null })}>
                        Make current again
                      </MenuItem>
                    ) : (
                      <MenuItem icon={<History />} disabled={p.sources.length < 2} onSelect={() => setSuperseding(s)}>
                        Replaced by another source…
                      </MenuItem>
                    )}
                    <MenuSeparator />
                    <MenuItem icon={<Trash2 />} danger onSelect={() => remove.mutate(s.id)}>
                      {s.projectOnly ? "Delete" : "Remove from project"}
                    </MenuItem>
                  </MenuContent>
                </Menu>
              )}
            </div>
          );
        })}
        {p.sources.length === 0 && uploading.length === 0 && (
          <p className="px-1.5 text-[12.5px] leading-relaxed text-fg-subtle">
            {p.canEdit
              ? "Add files, pasted text or saved answers. Every chat in this project can use them without attaching."
              : "No sources yet."}
          </p>
        )}
      </div>

      <Dialog
        open={noteOpen}
        onOpenChange={setNoteOpen}
        title="Add text"
        description="Paste meeting notes, requirements or anything the project should know."
        className="max-w-lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setNoteOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!noteTitle.trim() || !noteBody.trim()} loading={addNote.isPending} onClick={() => addNote.mutate()}>
              Add source
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Title">
            <Input autoFocus value={noteTitle} onChange={(e) => setNoteTitle(e.target.value)} placeholder="e.g. Kickoff meeting notes" />
          </Field>
          <Field label="Text">
            <Textarea value={noteBody} onChange={(e) => setNoteBody(e.target.value)} className="min-h-48" data-testid="note-body" />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={!!superseding}
        onOpenChange={(o) => !o && setSuperseding(null)}
        title="Replaced by which source?"
        description={superseding ? `“${superseding.name}” will be kept for reference but left out of answers.` : undefined}
      >
        <div className="-mx-1 max-h-72 space-y-px overflow-y-auto">
          {p.sources
            .filter((x) => x.id !== superseding?.id && !x.supersededById)
            .map((x) => (
              <button
                key={x.id}
                type="button"
                onClick={() => {
                  updateSource.mutate({ id: superseding!.id, supersededById: x.id });
                  setSuperseding(null);
                }}
                className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
              >
                <SourceIcon s={x} />
                <span className="min-w-0 flex-1 truncate">{x.name}</span>
              </button>
            ))}
        </div>
      </Dialog>

      <Dialog open={libraryOpen} onOpenChange={setLibraryOpen} title="Add from your documents" description="People in this project can read the documents you add.">
        <div className="-mx-1 max-h-80 space-y-px overflow-y-auto">
          {library.isLoading && <Skeleton className="h-8" />}
          {linkable.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => link.mutate(d.id)}
              className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <FileIcon name={d.name} />
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
              <Plus className="size-3.5 text-fg-subtle" />
            </button>
          ))}
          {library.data && linkable.length === 0 && (
            <p className="px-2 py-3 text-[12.5px] text-fg-subtle">
              Nothing left to add. Upload documents on the <Link href="/app/documents" className="text-fg underline-offset-2 hover:underline">Documents</Link> page.
            </p>
          )}
        </div>
      </Dialog>
    </Panel>
  );
}

function PeopleCard({ project: p, onOpen }: { project: ProjectDetail; onOpen: () => void }) {
  const people = [...(p.owner ? [{ id: p.owner.id, name: p.owner.name }] : []), ...p.members.map((m) => ({ id: m.userId, name: m.name }))];
  return (
    <Panel
      title="People"
      action={
        <Button variant="ghost" size="sm" className="-mr-1.5" onClick={onOpen}>
          {p.canEdit ? "Manage" : "View"}
        </Button>
      }
    >
      <div className="flex items-center gap-2">
        <div className="flex -space-x-1.5">
          {people.slice(0, 5).map((x) => (
            <Avatar key={x.id} name={x.name} className="size-6 border-2 border-surface text-[9px]" />
          ))}
        </div>
        <span className={cn("text-[12.5px] text-fg-subtle")}>
          {p.visibility === "workspace"
            ? "Everyone in the workspace"
            : people.length <= 1
              ? "Only the owner"
              : `${people.length} people`}
        </span>
      </div>
      <p className="mt-2.5 flex items-start gap-1.5 text-[12px] leading-snug text-fg-subtle">
        <FileText className="mt-px size-3.5 shrink-0" /> Chats are private to their author unless shared to the project.
      </p>
    </Panel>
  );
}
