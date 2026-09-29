"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  Tag,
  Download,
  FileText,
  Loader2,
  Lock,
  MessageSquarePlus,
  MoreHorizontal,
  RotateCcw,
  Search,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { TopBar } from "@/components/app/frame";
import { useSession } from "@/components/app/session";
import { ACCEPT, FileIcon, useDocuments } from "@/components/documents/use-documents";
import { Button } from "@/components/ui/button";
import { LabelBadge, LABELS } from "@/components/chat/citations";
import { Dialog, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/overlay";
import { Skeleton } from "@/components/ui/spinner";
import { del, formatBytes, patch, post, uploadDocument } from "@/lib/api";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import type { DocumentRow, SourceLabel } from "@/lib/types";

const FILTERS = [
  { v: "all", l: "All" },
  { v: "mine", l: "Uploaded by me" },
  { v: "shared", l: "Shared with workspace" },
] as const;

export default function DocumentsPage() {
  const { me, workspaceId, workspace } = useSession();
  const qc = useQueryClient();
  const router = useRouter();
  const docs = useDocuments(workspaceId);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["v"]>("all");
  const [q, setQ] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<DocumentRow | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isWsAdmin = me.isAdmin || workspace?.role === "admin";

  const refresh = () => qc.invalidateQueries({ queryKey: ["documents", workspaceId] });

  async function uploadFiles(files: FileList | File[]) {
    for (const f of Array.from(files)) {
      setUploading((u) => [...u, f.name]);
      try {
        await uploadDocument(workspaceId, f);
        refresh();
      } catch (e) {
        toast.error(`${f.name}: ${(e as Error).message}`);
      } finally {
        setUploading((u) => u.filter((n) => n !== f.name));
      }
    }
  }

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; scope?: "private" | "workspace"; label?: SourceLabel | null }) => patch(`/api/documents/${id}`, body),
    onSuccess: (_d, v) => {
      refresh();
      if (v.scope) toast.success(v.scope === "workspace" ? "Shared with the workspace" : "Made private");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const reprocess = useMutation({ mutationFn: (id: string) => post(`/api/documents/${id}/reprocess`), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/api/documents/${id}`),
    onSuccess: () => {
      refresh();
      toast("Document deleted");
      setConfirmDelete(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = useMemo(
    () =>
      (docs.data ?? []).filter(
        (d) =>
          (filter === "all" || (filter === "mine" ? d.ownerId === me.user.id : d.scope === "workspace")) &&
          d.name.toLowerCase().includes(q.trim().toLowerCase()),
      ),
    [docs.data, filter, q, me.user.id],
  );

  return (
    <div
      className="relative flex h-full min-h-0 flex-col"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
      }}
    >
      <TopBar
        icon={<FileText />}
        title="Documents"
        actions={
          <Button variant="primary" size="sm" onClick={() => inputRef.current?.click()}>
            <Upload className="size-3.5" /> Upload
          </Button>
        }
      />
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        data-testid="doc-upload"
        onChange={(e) => {
          if (e.target.files?.length) uploadFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
          <h1 className="font-serif text-[30px] leading-tight tracking-[-0.02em]">Documents</h1>
          <p className="mt-1 text-[13px] text-fg-subtle">
            Files you upload stay on your organization&apos;s servers. Attach them in chat to get answers with sources.
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <div className="flex rounded-lg border border-border bg-surface p-0.5">
              {FILTERS.map((f) => (
                <button
                  key={f.v}
                  onClick={() => setFilter(f.v)}
                  className={cn("h-7 rounded-md px-3 text-[13px] transition-colors", filter === f.v ? "bg-surface-3 text-fg" : "text-fg-muted hover:text-fg")}
                >
                  {f.l}
                </button>
              ))}
            </div>
            <label className="flex h-8 w-64 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 focus-within:border-border-strong">
              <Search className="size-3.5 text-fg-subtle" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search documents" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-subtle" />
            </label>
          </div>

          <div className="mt-4 overflow-hidden rounded-xl border border-border bg-surface">
            {uploading.map((n) => (
              <div key={n} className="flex items-center gap-3 border-b border-border px-4 py-3 text-[13px] last:border-0">
                <Loader2 className="size-4 animate-spin text-fg-subtle" />
                <span className="flex-1 truncate">{n}</span>
                <span className="text-fg-subtle">Uploading…</span>
              </div>
            ))}
            {docs.isLoading ? (
              <div className="space-y-3 p-4">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-9" />
                ))}
              </div>
            ) : rows.length === 0 && uploading.length === 0 ? (
              <button
                onClick={() => inputRef.current?.click()}
                className="flex w-full flex-col items-center justify-center gap-2 px-6 py-16 text-center transition-colors hover:bg-surface-2/50"
              >
                <span className="flex size-10 items-center justify-center rounded-xl border border-border bg-surface-2 text-fg-muted">
                  <Upload className="size-4" />
                </span>
                <span className="text-[14px] text-fg">{q || filter !== "all" ? "No documents match" : "Drop files here or click to upload"}</span>
                <span className="text-[12.5px] text-fg-subtle">PDF (scans too), Word, Excel, images, text, CSV and code · up to 25 MB</span>
              </button>
            ) : (
              rows.map((d) => {
                const canManage = d.ownerId === me.user.id || isWsAdmin;
                return (
                  <div key={d.id} className="group flex items-center gap-3 border-b border-border px-4 py-3 last:border-0 hover:bg-surface-2/40">
                    <FileIcon name={d.name} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13.5px] text-fg">{d.name}</span>
                        <LabelBadge label={d.label} />
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-fg-subtle">
                        <span>{formatBytes(d.sizeBytes)}</span>
                        {d.pageCount ? <span>· {d.pageCount} pages</span> : null}
                        <span>· {d.ownerId === me.user.id ? "you" : d.ownerName ?? "someone"}</span>
                        <span>· {timeAgo(d.createdAt)}</span>
                      </div>
                    </div>
                    <StatusPill doc={d} />
                    <span className="hidden w-28 items-center gap-1.5 text-[12px] text-fg-subtle sm:flex">
                      {d.scope === "workspace" ? <Users className="size-3.5" /> : <Lock className="size-3.5" />}
                      {d.scope === "workspace" ? "Workspace" : "Private"}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={d.status !== "ready"}
                      onClick={() => router.push(`/app/chat?doc=${d.id}`)}
                      className="max-sm:hidden"
                    >
                      <MessageSquarePlus className="size-3.5" /> Ask
                    </Button>
                    <Menu>
                      <MenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${d.name}`}>
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </MenuTrigger>
                      <MenuContent align="end">
                        <MenuItem icon={<MessageSquarePlus />} disabled={d.status !== "ready"} onSelect={() => router.push(`/app/chat?doc=${d.id}`)}>
                          Ask about this
                        </MenuItem>
                        <MenuItem icon={<Download />} onSelect={() => (window.location.href = `/api/documents/${d.id}/file`)}>
                          Download
                        </MenuItem>
                        {canManage && (
                          <>
                            <MenuItem
                              icon={d.scope === "workspace" ? <Lock /> : <Users />}
                              onSelect={() => update.mutate({ id: d.id, scope: d.scope === "workspace" ? "private" : "workspace" })}
                            >
                              {d.scope === "workspace" ? "Make private" : "Share with workspace"}
                            </MenuItem>
                            <MenuSeparator />
                            <MenuLabel>Label</MenuLabel>
                            {(["confirmed", "assumption", "tbd"] as const).map((l) => (
                              <MenuItem
                                key={l}
                                icon={<Tag />}
                                shortcut={d.label === l ? <Check className="size-3.5" /> : undefined}
                                onSelect={() => update.mutate({ id: d.id, label: d.label === l ? null : l })}
                              >
                                {LABELS[l].text}
                              </MenuItem>
                            ))}
                            {d.status === "failed" && (
                              <MenuItem icon={<RotateCcw />} onSelect={() => reprocess.mutate(d.id)}>
                                Try again
                              </MenuItem>
                            )}
                            <MenuSeparator />
                            <MenuItem icon={<Trash2 />} danger onSelect={() => setConfirmDelete(d)}>
                              Delete
                            </MenuItem>
                          </>
                        )}
                      </MenuContent>
                    </Menu>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-fg-subtle bg-bg/80 backdrop-blur-sm">
          <div className="text-center">
            <Upload className="mx-auto size-6 text-fg-muted" />
            <div className="mt-2 font-serif text-[22px]">Drop to upload</div>
          </div>
        </div>
      )}

      <Dialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={`Delete ${confirmDelete?.name}?`}
        description="It will be removed from every chat it's attached to. This can't be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => confirmDelete && remove.mutate(confirmDelete.id)}>
              Delete document
            </Button>
          </>
        }
      />
    </div>
  );
}

function StatusPill({ doc }: { doc: DocumentRow }) {
  if (doc.status === "ready") return <span className="hidden text-[12px] text-fg-subtle md:inline">Ready</span>;
  if (doc.status === "processing")
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-fg-muted">
        <Loader2 className="size-3.5 animate-spin" /> Processing
      </span>
    );
  return (
    <span className="inline-flex max-w-56 items-center gap-1.5 text-[12px] text-danger" title={doc.error ?? undefined}>
      <CircleAlert className="size-3.5 shrink-0" /> <span className="truncate">{doc.error ?? "Failed"}</span>
    </span>
  );
}
