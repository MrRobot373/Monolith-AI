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

  // Each address works once when the IDE has its own host, so a new tab gets a fresh one. The tab
  // opens right away (so it isn't blocked as a pop-up) and is pointed at the address when it arrives.
  const openInNewTab = async () => {
    const tab = window.open("", "_blank");
    if (!tab) return;
    tab.opener = null;
    try {
      tab.location.href = (await post<{ url: string }>(`/api/code/workspaces/${id}/open`)).url;
    } catch {
      tab.close();
    }
  };

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
            <TopBarButton onClick={openInNewTab} data-testid="open-ide-tab">
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
            // On its own host (IDE_URL) the frame is cross-origin and inherits nothing, so name the
            // features the IDE uses as a same-origin frame would have them (each still asks first).
            allow="clipboard-read; clipboard-write; cross-origin-isolated; autoplay; usb; serial; hid; local-network-access"
            data-testid="ide-frame"
          />
        )}
      </div>
    </div>
  );
}
