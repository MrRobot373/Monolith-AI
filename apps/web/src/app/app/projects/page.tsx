"use client";

import { FolderOpen, Globe, Lock, MessageSquare, Paperclip, Plus, Users } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { TopBar } from "@/components/app/frame";
import { useSession } from "@/components/app/session";
import { NewProjectDialog, ProjectIcon, useProjects } from "@/components/projects/projects";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/spinner";
import { timeAgo } from "@/lib/format";

export default function ProjectsPage() {
  const { me, workspaceId } = useSession();
  const projects = useProjects(workspaceId);
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar
        icon={<FolderOpen />}
        title="Projects"
        actions={
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" /> New project
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
          <h1 className="font-serif text-[30px] leading-tight tracking-[-0.02em]">Projects</h1>
          <p className="mt-1 max-w-xl text-[13px] text-fg-subtle">
            A project keeps the chats, files and instructions for one piece of work together. Chats inside a project remember each other and can use its files.
          </p>

          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.isLoading &&
              [0, 1, 2].map((i) => <Skeleton key={i} className="h-[132px] rounded-xl" />)}
            {projects.data?.map((p) => (
              <Link
                key={p.id}
                href={`/app/projects/${p.id}`}
                className="group flex min-w-0 flex-col rounded-xl border border-border bg-surface p-4 transition-colors hover:border-border-strong"
              >
                <div className="flex items-center gap-2.5">
                  <span className="flex size-8 items-center justify-center rounded-lg border border-border bg-bg">
                    <ProjectIcon color={p.color} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[14px] text-fg">{p.name}</span>
                  {p.visibility === "workspace" ? (
                    <Globe className="size-3.5 text-fg-subtle" aria-label="Shared with the workspace" />
                  ) : p.memberCount > 0 ? (
                    <Users className="size-3.5 text-fg-subtle" aria-label="Shared" />
                  ) : (
                    <Lock className="size-3.5 text-fg-subtle" aria-label="Private" />
                  )}
                </div>
                <p className="mt-2.5 line-clamp-2 min-h-[34px] text-[12.5px] leading-snug text-fg-subtle">
                  {p.description || "No description"}
                </p>
                <div className="mt-3 flex items-center gap-3 text-[11.5px] text-fg-subtle">
                  <span className="flex items-center gap-1">
                    <MessageSquare className="size-3" /> {p.chatCount}
                  </span>
                  <span className="flex items-center gap-1">
                    <Paperclip className="size-3" /> {p.sourceCount}
                  </span>
                  <span className="ml-auto">{p.ownerId === me.user.id ? "Yours" : "Shared with you"} · {timeAgo(p.updatedAt)}</span>
                </div>
              </Link>
            ))}
            {projects.data && (
              <button
                onClick={() => setCreating(true)}
                className="flex min-h-[132px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border text-[13px] text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
              >
                <Plus className="size-4" /> New project
              </button>
            )}
          </div>
        </div>
      </div>
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}
