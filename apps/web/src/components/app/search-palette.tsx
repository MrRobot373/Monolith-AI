"use client";

import { useQuery } from "@tanstack/react-query";
import { Archive, MessageSquare, Search, SquarePen } from "lucide-react";
import { Dialog as RDialog } from "radix-ui";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileIcon } from "@/components/documents/use-documents";
import { ProjectIcon } from "@/components/projects/projects";
import { Kbd } from "@/components/ui/misc";
import { Spinner } from "@/components/ui/spinner";
import { get } from "@/lib/api";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import type { ChatSummary, SearchResults } from "@/lib/types";
import { useSession } from "./session";

interface Item {
  key: string;
  group: string;
  icon: ReactNode;
  title: string;
  detail?: ReactNode;
  meta?: ReactNode;
  href: string;
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** ⌘K: search chat titles and messages, documents and projects in the current workspace. */
export function SearchPalette({ open, onOpenChange, recents }: { open: boolean; onOpenChange: (o: boolean) => void; recents: ChatSummary[] }) {
  const { workspaceId } = useSession();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const dq = useDebounced(q.trim(), 180);

  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
    }
  }, [open]);

  const results = useQuery({
    queryKey: ["search", workspaceId, dq],
    queryFn: () => get<SearchResults>(`/api/search?workspaceId=${workspaceId}&q=${encodeURIComponent(dq)}`),
    enabled: open && dq.length >= 2,
    placeholderData: (prev) => prev,
  });

  const items = useMemo<Item[]>(() => {
    if (dq.length < 2) {
      return [
        { key: "new", group: "Actions", icon: <SquarePen />, title: "New chat", href: "/app/chat" },
        ...recents.slice(0, 6).map((c) => ({
          key: `r-${c.id}`,
          group: "Recent chats",
          icon: <MessageSquare />,
          title: c.title,
          meta: timeAgo(c.updatedAt),
          href: `/app/chat/${c.id}`,
        })),
      ];
    }
    const r = results.data;
    if (!r) return [];
    return [
      ...r.projects.map((p) => ({
        key: `p-${p.id}`,
        group: "Projects",
        icon: <ProjectIcon color={p.color} />,
        title: p.name,
        href: `/app/projects/${p.id}`,
      })),
      ...r.chats.map((c) => ({
        key: `c-${c.id}`,
        group: "Chats",
        icon: c.archived ? <Archive /> : <MessageSquare />,
        title: c.title,
        detail: c.snippet,
        meta: (
          <span className="flex items-center gap-1.5">
            {c.projectName && <span className="max-w-32 truncate">{c.projectName}</span>}
            {c.archived && <span>Archived</span>}
            <span>{timeAgo(c.updatedAt)}</span>
          </span>
        ),
        href: c.projectId ? `/app/projects/${c.projectId}/${c.id}` : `/app/chat/${c.id}`,
      })),
      ...r.documents.map((d) => ({
        key: `d-${d.id}`,
        group: "Documents",
        icon: <FileIcon name={d.name} />,
        title: d.name,
        href: d.projectId ? `/app/projects/${d.projectId}` : `/app/documents`,
      })),
    ];
  }, [dq, recents, results.data]);

  useEffect(() => setActive(0), [items.length, dq]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const go = (it: Item | undefined) => {
    if (!it) return;
    onOpenChange(false);
    router.push(it.href);
  };

  let lastGroup = "";
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-fade-in" />
        <RDialog.Content
          aria-label="Search"
          className="fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-32px)] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-soft outline-none data-[state=open]:animate-rise"
        >
          <RDialog.Title className="sr-only">Search</RDialog.Title>
          <RDialog.Description className="sr-only">Search chats, documents and projects</RDialog.Description>
          <div className="flex h-12 items-center gap-2.5 border-b border-border px-4">
            <Search className="size-4 shrink-0 text-fg-subtle" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((a) => Math.min(items.length - 1, a + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  go(items[active]);
                }
              }}
              placeholder="Search chats, messages, documents and projects"
              className="min-w-0 flex-1 bg-transparent text-[14px] text-fg outline-none placeholder:text-fg-subtle"
              data-testid="search-input"
            />
            {results.isFetching && <Spinner className="size-3.5" />}
            <Kbd>Esc</Kbd>
          </div>
          <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
            {items.map((it, i) => {
              const header = it.group !== lastGroup ? it.group : null;
              lastGroup = it.group;
              return (
                <div key={it.key}>
                  {header && <div className="px-2.5 pt-2 pb-1 text-[11.5px] text-fg-subtle">{header}</div>}
                  <button
                    type="button"
                    data-index={i}
                    onMouseMove={() => setActive(i)}
                    onClick={() => go(it)}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                      i === active ? "bg-surface-2" : "",
                    )}
                  >
                    <span className="mt-px shrink-0 text-fg-subtle [&>svg]:size-4">{it.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-fg">{it.title}</span>
                      {it.detail && <span className="mt-0.5 line-clamp-2 block text-[12px] leading-snug text-fg-subtle">{it.detail}</span>}
                    </span>
                    {it.meta && <span className="mt-px shrink-0 text-[11.5px] text-fg-subtle">{it.meta}</span>}
                  </button>
                </div>
              );
            })}
            {dq.length >= 2 && results.data && items.length === 0 && (
              <p className="px-3 py-6 text-center text-[13px] text-fg-subtle">Nothing matches “{dq}”.</p>
            )}
          </div>
          <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[11.5px] text-fg-subtle">
            <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> to move</span>
            <span className="flex items-center gap-1"><Kbd>↵</Kbd> to open</span>
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
