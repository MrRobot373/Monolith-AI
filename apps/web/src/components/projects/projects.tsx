"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Folder, Globe, Lock, Trash2, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSession } from "@/components/app/session";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Avatar } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import { ApiError, del, get, patch, post, put } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { DocumentRow, Person, ProjectDetail, ProjectSummary } from "@/lib/types";

export const PROJECT_HUES = ["190", "260", "330", "25", "145", "45", "210", "0"];

export function useProjects(workspaceId: string) {
  return useQuery({
    queryKey: ["projects", workspaceId],
    queryFn: () => get<ProjectSummary[]>(`/api/projects?workspaceId=${workspaceId}`),
    enabled: !!workspaceId,
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ["project", id],
    queryFn: () => get<ProjectDetail>(`/api/projects/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.sources.some((s) => s.status === "processing") ? 1500 : false),
  });
}

/** A folder tinted with the project colour. */
export function ProjectIcon({ color, className }: { color?: string | null; className?: string }) {
  return <Folder className={cn("size-4 shrink-0", className)} style={{ color: `oklch(0.72 0.13 ${color ?? "190"})` }} aria-hidden />;
}

export async function uploadProjectSource(projectId: string, file: File) {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/projects/${projectId}/sources/upload`, { method: "POST", credentials: "include", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? "Upload failed", data.code);
  return data as DocumentRow;
}

function HuePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex gap-1.5" role="radiogroup" aria-label="Colour">
      {PROJECT_HUES.map((h) => (
        <button
          key={h}
          type="button"
          role="radio"
          aria-checked={value === h}
          onClick={() => onChange(h)}
          className={cn(
            "flex size-7 items-center justify-center rounded-lg border transition-colors",
            value === h ? "border-fg-subtle bg-surface-2" : "border-border hover:border-border-strong",
          )}
        >
          <ProjectIcon color={h} />
        </button>
      ))}
    </div>
  );
}

export function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { workspaceId } = useSession();
  const qc = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState("");
  const [color, setColor] = useState("190");
  const [instructions, setInstructions] = useState("");
  useEffect(() => {
    if (open) {
      setName("");
      setInstructions("");
      setColor(PROJECT_HUES[Math.floor(Math.random() * PROJECT_HUES.length)]!);
    }
  }, [open]);
  const create = useMutation({
    mutationFn: () => post<{ id: string }>("/api/projects", { workspaceId, name: name.trim(), color, instructions: instructions.trim() || undefined }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ["projects", workspaceId] });
      onOpenChange(false);
      router.push(`/app/projects/${p.id}`);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New project"
      description="Keep chats, files and instructions for one piece of work together."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            Create project
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Q3 board report"
            onKeyDown={(e) => e.key === "Enter" && name.trim() && create.mutate()}
          />
        </Field>
        <Field label="Colour">
          <HuePicker value={color} onChange={setColor} />
        </Field>
        <Field label="Instructions" hint="Optional. Every chat in this project follows these, instead of your personal instructions.">
          <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. Answer as a concise checklist. Our fiscal year starts in April." />
        </Field>
      </div>
    </Dialog>
  );
}

export function ProjectSettingsDialog({ project, open, onOpenChange }: { project: ProjectDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const { workspaceId } = useSession();
  const [name, setName] = useState(project.name);
  const [color, setColor] = useState(project.color);
  const [description, setDescription] = useState(project.description ?? "");
  const [instructions, setInstructions] = useState(project.instructions ?? "");
  useEffect(() => {
    if (!open) return;
    setName(project.name);
    setColor(project.color);
    setDescription(project.description ?? "");
    setInstructions(project.instructions ?? "");
  }, [open, project]);
  const save = useMutation({
    mutationFn: () =>
      patch(`/api/projects/${project.id}`, { name: name.trim(), color, description: description.trim() || null, instructions: instructions.trim() || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", project.id] });
      qc.invalidateQueries({ queryKey: ["projects", workspaceId] });
      onOpenChange(false);
      toast("Project saved");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Project settings"
      className="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim()} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Colour">
          <HuePicker value={color} onChange={setColor} />
        </Field>
        <Field label="Description">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this project about?" />
        </Field>
        <Field label="Instructions" hint="Chats in this project follow these instead of each person's own custom instructions.">
          <Textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            className="min-h-40"
            placeholder="e.g. You are helping the finance team. Always cite the source file. Use INR."
            data-testid="project-instructions"
          />
        </Field>
      </div>
    </Dialog>
  );
}

export function ShareProjectDialog({ project, open, onOpenChange }: { project: ProjectDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const { me, workspaceId } = useSession();
  const [adding, setAdding] = useState("");
  const [role, setRole] = useState<"chat" | "edit">("chat");
  const people = useQuery({
    queryKey: ["people", workspaceId],
    queryFn: () => get<Person[]>(`/api/workspaces/${workspaceId}/people`),
    enabled: open && !!workspaceId,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["project", project.id] });
    qc.invalidateQueries({ queryKey: ["projects", workspaceId] });
  };
  const onError = (e: unknown) => toast.error((e as Error).message);
  const setVisibility = useMutation({
    mutationFn: (visibility: "private" | "workspace") => patch(`/api/projects/${project.id}`, { visibility }),
    onSuccess: refresh,
    onError,
  });
  const setMember = useMutation({
    mutationFn: (b: { userId: string; role: "chat" | "edit" }) => put(`/api/projects/${project.id}/members`, b),
    onSuccess: () => {
      refresh();
      setAdding("");
    },
    onError,
  });
  const removeMember = useMutation({
    mutationFn: (userId: string) => del(`/api/projects/${project.id}/members/${userId}`),
    onSuccess: refresh,
    onError,
  });
  const candidates = useMemo(
    () => (people.data ?? []).filter((p) => p.id !== project.ownerId && !project.members.some((m) => m.userId === p.id)),
    [people.data, project],
  );
  const editable = project.canEdit;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Share “${project.name}”`}
      description="People you share with can use the project's instructions and sources. Chats stay private unless their author shares them to the project."
      className="max-w-lg"
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              { v: "private", icon: Lock, t: "Only people invited", d: "You and the people below" },
              { v: "workspace", icon: Globe, t: "Everyone in the workspace", d: "Anyone can open and chat" },
            ] as const
          ).map((o) => (
            <button
              key={o.v}
              type="button"
              disabled={!editable}
              onClick={() => o.v !== project.visibility && setVisibility.mutate(o.v)}
              className={cn(
                "flex items-start gap-2.5 rounded-xl border p-3 text-left transition-colors disabled:cursor-default",
                project.visibility === o.v ? "border-fg-subtle bg-surface-2" : "border-border hover:border-border-strong",
              )}
            >
              <o.icon className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
              <span className="min-w-0">
                <span className="block text-[13px] text-fg">{o.t}</span>
                <span className="block text-[12px] text-fg-subtle">{o.d}</span>
              </span>
              {project.visibility === o.v && <Check className="ml-auto size-3.5 shrink-0 text-fg" />}
            </button>
          ))}
        </div>

        {editable && (
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <Select value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Person to add">
                <option value="">{candidates.length ? "Add a person from this workspace…" : "Everyone here already has access"}</option>
                {candidates.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.email}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-28">
              <Select value={role} onChange={(e) => setRole(e.target.value as "chat" | "edit")} aria-label="Role">
                <option value="chat">Can chat</option>
                <option value="edit">Can edit</option>
              </Select>
            </div>
            <Button variant="primary" disabled={!adding} loading={setMember.isPending} onClick={() => setMember.mutate({ userId: adding, role })}>
              <UserPlus className="size-3.5" /> Add
            </Button>
          </div>
        )}

        <div className="divide-y divide-border rounded-xl border border-border">
          {project.owner && (
            <div className="flex items-center gap-3 px-3 py-2.5">
              <Avatar name={project.owner.name} className="size-7" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-fg">
                  {project.owner.name} {project.owner.id === me.user.id && <span className="text-fg-subtle">(you)</span>}
                </div>
                <div className="truncate text-[12px] text-fg-subtle">{project.owner.email}</div>
              </div>
              <span className="text-[12px] text-fg-subtle">Owner</span>
            </div>
          )}
          {project.members.map((m) => (
            <div key={m.userId} className="flex items-center gap-3 px-3 py-2.5">
              <Avatar name={m.name} image={m.image} className="size-7" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-fg">
                  {m.name} {m.userId === me.user.id && <span className="text-fg-subtle">(you)</span>}
                </div>
                <div className="truncate text-[12px] text-fg-subtle">{m.email}</div>
              </div>
              {editable ? (
                <>
                  <div className="w-28">
                    <Select
                      value={m.role}
                      aria-label={`Role for ${m.name}`}
                      onChange={(e) => setMember.mutate({ userId: m.userId, role: e.target.value as "chat" | "edit" })}
                      className="h-8"
                    >
                      <option value="chat">Can chat</option>
                      <option value="edit">Can edit</option>
                    </Select>
                  </div>
                  <Button variant="ghost" size="icon-sm" aria-label={`Remove ${m.name}`} onClick={() => removeMember.mutate(m.userId)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </>
              ) : (
                <span className="text-[12px] text-fg-subtle">{m.role === "edit" ? "Can edit" : "Can chat"}</span>
              )}
            </div>
          ))}
          {project.members.length === 0 && (
            <p className="px-3 py-3 text-[12.5px] text-fg-subtle">
              {project.visibility === "workspace" ? "Everyone in the workspace can chat here." : "Nobody else has access yet."}
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Pick a project to move a chat into (or take it out of its project). */
export function MoveToProjectDialog({
  chat,
  onOpenChange,
}: {
  chat: { id: string; title: string; projectId?: string | null } | null;
  onOpenChange: (o: boolean) => void;
}) {
  const { workspaceId } = useSession();
  const qc = useQueryClient();
  const projects = useProjects(workspaceId);
  const move = useMutation({
    mutationFn: (projectId: string | null) => patch(`/api/chats/${chat!.id}`, { projectId }),
    onSuccess: (_d, projectId) => {
      qc.invalidateQueries({ queryKey: ["chats", workspaceId] });
      qc.invalidateQueries({ queryKey: ["projects", workspaceId] });
      qc.invalidateQueries({ queryKey: ["project"] });
      qc.invalidateQueries({ queryKey: ["chat", chat!.id] });
      const name = projects.data?.find((p) => p.id === projectId)?.name;
      toast(projectId ? `Moved to ${name}` : "Removed from project");
      onOpenChange(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Dialog open={!!chat} onOpenChange={onOpenChange} title="Move to project" description={chat ? `“${chat.title}”` : undefined}>
      <div className="max-h-72 space-y-px overflow-y-auto">
        {(projects.data ?? []).map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={move.isPending}
            onClick={() => move.mutate(p.id)}
            className={cn(
              "flex h-9 w-full items-center gap-2.5 rounded-lg px-2 text-left text-[13px] transition-colors hover:bg-surface-2",
              chat?.projectId === p.id ? "text-fg" : "text-fg-muted",
            )}
          >
            <ProjectIcon color={p.color} />
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            {chat?.projectId === p.id && <Check className="size-3.5" />}
          </button>
        ))}
        {projects.data?.length === 0 && <p className="px-2 py-2 text-[12.5px] text-fg-subtle">You have no projects yet. Create one from the sidebar.</p>}
        {chat?.projectId && (
          <button
            type="button"
            onClick={() => move.mutate(null)}
            className="mt-1 flex h-9 w-full items-center gap-2.5 rounded-lg border-t border-border px-2 text-left text-[13px] text-fg-muted hover:bg-surface-2"
          >
            Remove from project
          </button>
        )}
      </div>
    </Dialog>
  );
}
