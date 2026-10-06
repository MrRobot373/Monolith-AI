"use client";

import { useQuery } from "@tanstack/react-query";
import { get } from "./api";

export type TaskStatus = "queued" | "running" | "needs_approval" | "completed" | "failed" | "cancelled";

export interface WorkTaskSummary {
  id: string;
  title: string;
  status: TaskStatus;
  result: string | null;
  error: string | null;
  pinned: boolean;
  modelId: string | null;
  scheduleId: string | null;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface WorkEvent {
  seq: number;
  kind: "user" | "assistant" | "tool_call" | "tool_result" | "approval" | "plan" | "status" | string;
  data: Record<string, any>;
  at?: string;
}

export interface WorkTaskDetail {
  task: WorkTaskSummary & { workspaceId: string; sessionId: string | null; projectId: string | null };
  events: WorkEvent[];
  live: boolean;
}

export interface PendingApproval {
  id: string;
  taskId: string;
  taskTitle: string;
  toolName: string;
  reason: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface WorkFile {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface WorkInfo {
  webSearch: boolean;
  approvals: "risky" | "always" | "never";
  allowNetwork: boolean;
  maxConcurrentPerUser: number;
}

export interface Skill {
  id: string;
  scope: "org" | "personal";
  ownerId: string | null;
  slug: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  editable: boolean;
  updatedAt: string;
}

export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  modelId: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastTaskId: string | null;
  lastStatus: TaskStatus | null;
}

export const ACTIVE: TaskStatus[] = ["queued", "running", "needs_approval"];

export function useWorkTasks(workspaceId: string) {
  return useQuery({
    queryKey: ["work-tasks", workspaceId],
    queryFn: () => get<WorkTaskSummary[]>(`/api/work/tasks?workspaceId=${workspaceId}`),
    enabled: !!workspaceId,
    // Keep statuses fresh while something is running.
    refetchInterval: (q) => (q.state.data?.some((t) => ACTIVE.includes(t.status)) ? 4000 : false),
  });
}

export function usePendingApprovals(workspaceId: string) {
  return useQuery({
    queryKey: ["work-approvals", workspaceId],
    queryFn: () => get<PendingApproval[]>(`/api/work/approvals?workspaceId=${workspaceId}`),
    enabled: !!workspaceId,
    refetchInterval: 10_000,
  });
}

export function useWorkInfo(workspaceId: string) {
  return useQuery({
    queryKey: ["work-info", workspaceId],
    queryFn: () => get<WorkInfo>(`/api/work/info?workspaceId=${workspaceId}`),
    enabled: !!workspaceId,
    staleTime: 60_000,
  });
}

/** One-line description of a tool call, for the timeline. */
export function describeCall(name: string, args: any): { verb: string; target?: string } {
  const a = (args ?? {}) as Record<string, any>;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return { verb: `Used ${mcp[1]}`, target: mcp[2]!.replaceAll("_", " ") };
  switch (name) {
    case "bash":
    case "pwsh":
      return { verb: "Ran", target: String(a.command ?? "").split("\n")[0] };
    case "write":
      return { verb: "Wrote", target: a.path ?? a.file_path };
    case "edit":
    case "str_replace_editor":
      return { verb: "Edited", target: a.path ?? a.file_path };
    case "read":
    case "read_image":
      return { verb: "Read", target: a.path ?? a.file_path };
    case "glob":
      return { verb: "Looked for files", target: a.pattern };
    case "grep":
      return { verb: "Searched files for", target: a.pattern };
    case "web_search":
      return { verb: "Searched the web", target: Array.isArray(a.queries) ? a.queries.join(" · ") : a.query };
    case "web_fetch":
      return { verb: "Opened", target: a.url };
    case "skill":
      return { verb: "Used skill", target: a.name ?? a.skill };
    case "todo_write": {
      const todos = (Array.isArray(a.todos) ? a.todos : []) as { content: string; status: string }[];
      if (todos.length && todos.every((t) => t.status === "completed")) return { verb: "Finished the plan" };
      const now = todos.find((t) => t.status === "in_progress");
      return { verb: now ? `Plan: ${now.content}` : `Planned ${todos.length} steps` };
    }
    case "subagent":
    case "subagent_fork":
      return { verb: "Asked a helper agent", target: a.description ?? a.task };
    default:
      return { verb: `Used ${name.replaceAll("_", " ")}` };
  }
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "Queued",
  running: "Working",
  needs_approval: "Needs approval",
  completed: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};
