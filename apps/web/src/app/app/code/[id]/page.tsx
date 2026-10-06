"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Code2, ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { TopBar, TopBarButton } from "@/components/app/frame";
import { useSession } from "@/components/app/session";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import { useCodeWorkspaces } from "@/lib/code";

/** The IDE, full height inside the Aatmiq window. It starts the person's IDE server if needed. */
export default function CodeWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const { workspaceId } = useSession();
  const list = useCodeWorkspaces(workspaceId);
  const w = list.data?.find((x) => x.id === id);
  const open = useQuery({
    queryKey: ["code-open", id],
    queryFn: () => post<{ url: string }>(`/api/code/workspaces/${id}/open`),
    staleTime: Infinity,
    retry: false,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar
        icon={<Code2 />}
        leading={
          <Link href="/app/code" className="rounded-md p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg" aria-label="All workspaces">
            <ArrowLeft className="size-4" />
          </Link>
        }
        title={w?.name ?? "Workspace"}
        actions={
          open.data && (
            <TopBarButton onClick={() => window.open(open.data.url, "_blank", "noopener")} data-testid="open-ide-tab">
              <ExternalLink /> <span className="hidden sm:inline">Open in new tab</span>
            </TopBarButton>
          )
        }
      />
      <div className="relative min-h-0 flex-1 bg-[#0c0c0c]">
        {open.isPending && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-[13px] text-fg-subtle">
            <Loader2 className="size-5 animate-spin" />
            Starting your editor…
          </div>
        )}
        {open.error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-[13px]">
            <TriangleAlert className="size-5 text-warning" />
            <div className="max-w-md text-fg-muted">{(open.error as Error).message}</div>
            <Button variant="outline" size="sm" onClick={() => open.refetch()}>Try again</Button>
          </div>
        )}
        {open.data && (
          <iframe
            key={open.data.url}
            src={open.data.url}
            title={`${w?.name ?? "Workspace"} in Aatmiq Code`}
            className="absolute inset-0 h-full w-full border-0"
            allow="clipboard-read; clipboard-write"
            data-testid="ide-frame"
          />
        )}
      </div>
    </div>
  );
}
