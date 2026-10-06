"use client";

import { useQuery } from "@tanstack/react-query";
import { get } from "./api";

export interface CodeWorkspace {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  gitUrl: string | null;
  status: "ready" | "cloning" | "failed";
  error: string | null;
  path: string;
  lastOpenedAt: string | null;
  createdAt: string;
}

export interface CodeStatus {
  installed: boolean;
  running: boolean;
  allowed: boolean;
}

export function useCodeWorkspaces(workspaceId: string) {
  return useQuery({
    queryKey: ["code-workspaces", workspaceId],
    queryFn: () => get<CodeWorkspace[]>(`/api/code/workspaces?workspaceId=${workspaceId}`),
    enabled: !!workspaceId,
    refetchInterval: (q) => (q.state.data?.some((w) => w.status === "cloning") ? 2000 : false),
  });
}

export function useCodeStatus() {
  return useQuery({ queryKey: ["code-status"], queryFn: () => get<CodeStatus>("/api/code/status"), staleTime: 30_000 });
}
