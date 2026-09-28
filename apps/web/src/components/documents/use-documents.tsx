"use client";

import { useQuery } from "@tanstack/react-query";
import { File, FileCode2, FileSpreadsheet, FileText } from "lucide-react";
import { get } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { DocumentRow } from "@/lib/types";

/** Workspace document library; polls while anything is still processing. */
export function useDocuments(workspaceId: string) {
  return useQuery({
    queryKey: ["documents", workspaceId],
    queryFn: () => get<DocumentRow[]>(`/api/documents?workspaceId=${workspaceId}`),
    enabled: !!workspaceId,
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === "processing") ? 1500 : false),
  });
}

export const ACCEPT =
  ".pdf,.docx,.txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.htm,.log,.js,.jsx,.ts,.tsx,.py,.java,.go,.rs,.rb,.php,.c,.h,.cpp,.cs,.kt,.swift,.sql,.sh,.css";

export function FileIcon({ name, className }: { name: string; className?: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const Icon = ["csv", "tsv", "xlsx"].includes(ext)
    ? FileSpreadsheet
    : ["pdf", "docx", "txt", "md", "markdown"].includes(ext)
      ? FileText
      : ["json", "yaml", "yml", "xml", "html", "htm"].includes(ext) || ext.length <= 4
        ? FileCode2
        : File;
  const tone =
    ext === "pdf" ? "text-[oklch(0.68_0.16_25)]" : ext === "docx" ? "text-[oklch(0.68_0.14_255)]" : ["csv", "tsv"].includes(ext) ? "text-[oklch(0.7_0.14_150)]" : "text-fg-subtle";
  return <Icon className={cn("size-4 shrink-0", tone, className)} />;
}
