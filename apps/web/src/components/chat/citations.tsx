"use client";

import { Download, FileText } from "lucide-react";
import { useState } from "react";
import { FileIcon } from "@/components/documents/use-documents";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import type { Citation } from "@/lib/types";

/** Turn "[2]" markers that match real sources into links the Markdown renderer shows as chips. */
export function linkCitations(text: string, citations: Citation[] | null | undefined): string {
  if (!citations?.length) return text;
  const ns = new Set(citations.map((c) => c.n));
  return text.replace(/\[(\d{1,2})\](?!\()/g, (m, n) => (ns.has(Number(n)) ? `[${n}](#cite-${n})` : m));
}

export function CitationChip({ citation, onOpen }: { citation: Citation; onOpen: (c: Citation) => void }) {
  return (
    <Tooltip
      content={
        <span className="block max-w-64">
          <span className="block text-fg">{citation.name}</span>
          {citation.page && <span className="text-fg-subtle">Page {citation.page}</span>}
        </span>
      }
    >
      <button
        type="button"
        data-cite={citation.n}
        onClick={() => onOpen(citation)}
        className="mx-0.5 inline-flex h-[18px] min-w-[18px] -translate-y-px items-center justify-center rounded-[5px] border border-border-strong bg-surface-2 px-1 align-middle font-sans text-[10.5px] font-medium text-fg-muted no-underline transition-colors hover:border-fg-subtle hover:text-fg"
      >
        {citation.n}
      </button>
    </Tooltip>
  );
}

export function SourcesRow({ citations, onOpen }: { citations: Citation[]; onOpen: (c: Citation) => void }) {
  return (
    <div className="mt-3">
      <div className="mb-1.5 text-[12px] text-fg-subtle">Sources</div>
      <div className="flex flex-wrap gap-1.5">
        {citations.map((c) => (
          <button
            key={c.n}
            type="button"
            onClick={() => onOpen(c)}
            className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-[12.5px] text-fg-muted transition-colors hover:border-border-strong hover:text-fg"
          >
            <span className="text-[11px] text-fg-subtle">{c.n}</span>
            <FileIcon name={c.name} className="size-3.5" />
            <span className="truncate">{c.name}</span>
            {c.page && <span className="shrink-0 text-fg-subtle">p.{c.page}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function useSourceDialog() {
  const [open, setOpen] = useState<Citation | null>(null);
  const dialog = (
    <Dialog
      open={!!open}
      onOpenChange={(o) => !o && setOpen(null)}
      className="max-w-xl"
      title={
        <span className="flex items-center gap-2">
          <FileText className="size-4 text-fg-subtle" />
          {open?.name}
        </span>
      }
      description={open ? `Source ${open.n}${open.page ? ` · page ${open.page}` : ""}` : undefined}
      footer={
        <Button variant="outline" onClick={() => open && (window.location.href = `/api/documents/${open.documentId}/file`)}>
          <Download className="size-3.5" /> Download document
        </Button>
      }
    >
      <blockquote className="max-h-80 overflow-y-auto rounded-lg border border-border bg-bg px-4 py-3 text-[13px] leading-relaxed whitespace-pre-wrap text-fg-muted">
        {open?.snippet}
        {open && open.snippet.length >= 700 ? "…" : ""}
      </blockquote>
    </Dialog>
  );
  return { openSource: setOpen, sourceDialog: dialog };
}
