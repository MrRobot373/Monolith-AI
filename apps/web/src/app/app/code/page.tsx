"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Code2, FolderGit2, Folder, Loader2, MoreHorizontal, Pencil, Plus, Sparkles, Terminal, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { TopBar } from "@/components/app/frame";
import { useSession } from "@/components/app/session";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/misc";
import { Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlay";
import { Skeleton } from "@/components/ui/spinner";
import { del, patch, post } from "@/lib/api";
import { useCodeStatus, useCodeWorkspaces, type CodeWorkspace } from "@/lib/code";
import { timeAgo } from "@/lib/format";

export default function CodePage() {
  const { workspaceId } = useSession();
  const qc = useQueryClient();
  const router = useRouter();
  const status = useCodeStatus();
  const list = useCodeWorkspaces(workspaceId);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<CodeWorkspace | null>(null);
  const [removing, setRemoving] = useState<CodeWorkspace | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["code-workspaces", workspaceId] });
  const remove = useMutation({
    mutationFn: (w: CodeWorkspace) => del(`/api/code/workspaces/${w.id}`),
    onSuccess: () => {
      refresh();
      setRemoving(null);
      toast("Workspace deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = list.data ?? [];
  const notInstalled = status.data && !status.data.installed;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar
        icon={<Code2 />}
        title="Code"
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreating(true)} disabled={notInstalled} data-testid="new-code-workspace">
            <Plus className="size-3.5" /> New workspace
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
          <h1 className="font-serif text-[30px] leading-tight tracking-[-0.02em]">Code</h1>
          <p className="mt-1 max-w-2xl text-[13px] text-fg-subtle">
            Aatmiq Code is a full VS Code–based editor running on your organization&apos;s servers, with terminals, Git and Open VSX extensions. The Aatmiq panel on the right is a coding agent that works in your workspace.
          </p>

          {notInstalled && (
            <div className="mt-6 flex items-start gap-3 rounded-xl border border-warning/40 bg-surface px-4 py-3 text-[13px]">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <div>
                <div className="text-fg">Aatmiq Code isn&apos;t installed on this server yet.</div>
                <div className="text-fg-subtle">An administrator can build it with <code className="font-mono text-[12px]">pnpm --filter @aatmiq/code build</code> (the Docker image includes it).</div>
              </div>
            </div>
          )}

          {list.isLoading ? (
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-[124px] rounded-xl" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              className="mt-6 rounded-xl border border-dashed border-border"
              icon={<Code2 className="size-5" />}
              title="No workspaces yet"
              description="Start an empty workspace or clone a Git repository. Each workspace is a folder only you can open."
              action={
                !notInstalled && (
                  <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                    <Plus className="size-3.5" /> New workspace
                  </Button>
                )
              }
            />
          ) : (
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="code-workspaces">
              {rows.map((w) => (
                <div key={w.id} className="group relative flex min-w-0 flex-col rounded-xl border border-border bg-surface p-4 transition-colors hover:border-border-strong" data-testid="code-workspace">
                  <Link href={w.status === "ready" ? `/app/code/${w.id}` : "#"} className="absolute inset-0 rounded-xl" aria-label={`Open ${w.name}`} onClick={(e) => w.status !== "ready" && e.preventDefault()} />
                  <div className="flex items-center gap-2.5">
                    <span className="flex size-8 items-center justify-center rounded-lg border border-border bg-bg">
                      {w.status === "cloning" ? <Loader2 className="size-4 animate-spin text-fg-subtle" /> : w.gitUrl ? <FolderGit2 className="size-4 text-fg-muted" /> : <Folder className="size-4 text-fg-muted" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[14px] text-fg">{w.name}</span>
                    <Menu>
                      <MenuTrigger asChild>
                        <button className="relative z-10 rounded p-1 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 hover:bg-surface-2 hover:text-fg focus:opacity-100" aria-label={`Options for ${w.name}`}>
                          <MoreHorizontal className="size-4" />
                        </button>
                      </MenuTrigger>
                      <MenuContent align="end">
                        <MenuItem icon={<Pencil />} onSelect={() => setRenaming(w)}>Rename</MenuItem>
                        <MenuSeparator />
                        <MenuItem icon={<Trash2 />} danger onSelect={() => setRemoving(w)}>Delete</MenuItem>
                      </MenuContent>
                    </Menu>
                  </div>
                  <p className="mt-2.5 truncate font-mono text-[11.5px] text-fg-subtle">{w.gitUrl ?? `~/workspaces/${w.slug}`}</p>
                  <div className="mt-auto pt-3 text-[12px]">
                    {w.status === "cloning" ? (
                      <span className="text-fg-muted">Cloning…</span>
                    ) : w.status === "failed" ? (
                      <span className="line-clamp-2 text-danger">{w.error ?? "Couldn't create this workspace."}</span>
                    ) : (
                      <span className="text-fg-subtle">{w.lastOpenedAt ? `Opened ${timeAgo(w.lastOpenedAt)}` : "Not opened yet"}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-10 grid gap-3 sm:grid-cols-3">
            {[
              { icon: Terminal, title: "Terminals and Git", text: "A real shell on the server, Git with your name on commits, and extensions from Open VSX." },
              { icon: Sparkles, title: "Aatmiq panel", text: "Ask the agent to explain, change or test code. It edits your files and asks before anything risky." },
              { icon: Folder, title: "Private to you", text: "Your workspaces run as your own user on the server. Nobody else can open them." },
            ].map((f) => (
              <div key={f.title} className="rounded-xl border border-border p-4">
                <f.icon className="size-4 text-fg-subtle" />
                <div className="mt-2 text-[13px] text-fg">{f.title}</div>
                <p className="mt-1 text-[12.5px] leading-relaxed text-fg-subtle">{f.text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {creating && (
        <NewWorkspaceDialog
          workspaceId={workspaceId}
          onClose={() => setCreating(false)}
          onCreated={(w) => {
            refresh();
            setCreating(false);
            if (w.status === "ready") router.push(`/app/code/${w.id}`);
            else toast("Cloning the repository. It opens when it's ready.");
          }}
        />
      )}
      {renaming && <RenameDialog w={renaming} onClose={() => setRenaming(null)} onSaved={refresh} />}
      <Dialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Delete “${removing?.name}”?`}
        description="The folder and everything in it is deleted from the server, including changes you haven't pushed. This can't be undone."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => removing && remove.mutate(removing)}>Delete workspace</Button>
          </>
        }
      />
    </div>
  );
}

function NewWorkspaceDialog({ workspaceId, onClose, onCreated }: { workspaceId: string; onClose: () => void; onCreated: (w: CodeWorkspace) => void }) {
  const [name, setName] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const create = useMutation({
    mutationFn: () => post<CodeWorkspace>("/api/code/workspaces", { workspaceId, name: name.trim(), gitUrl: gitUrl.trim() }),
    onSuccess: onCreated,
    onError: (e: Error) => toast.error(e.message),
  });
  const guess = (url: string) => url.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() ?? "";
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New workspace"
      description="Start empty, or clone a repository. Private repositories work over https with a token in the address, for now."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()} data-testid="create-code-workspace">
            {gitUrl.trim() ? "Clone" : "Create"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Git repository (optional)">
          <Input
            value={gitUrl}
            onChange={(e) => {
              const v = e.target.value;
              if (!name || name === guess(gitUrl)) setName(guess(v));
              setGitUrl(v);
            }}
            placeholder="https://github.com/acme/billing-service.git"
            className="font-mono text-[12.5px]"
            data-testid="code-git-url"
          />
        </Field>
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="billing-service" data-testid="code-workspace-name" />
        </Field>
      </div>
    </Dialog>
  );
}

function RenameDialog({ w, onClose, onSaved }: { w: CodeWorkspace; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(w.name);
  const save = useMutation({
    mutationFn: () => patch(`/api/code/workspaces/${w.id}`, { name: name.trim() }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Rename workspace"
      description="The folder name stays the same."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </>
      }
    >
      <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
    </Dialog>
  );
}
