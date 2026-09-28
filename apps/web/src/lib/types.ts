import type { OrgRole, QuotaResult, Section, WorkspaceRole } from "@aatmiq/shared";

export interface Me {
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
    orgRole: OrgRole;
    jobTitle: string | null;
    customInstructions: string | null;
    createdAt: string;
  };
  isAdmin: boolean;
  isWorkspaceAdmin: boolean;
  org: { name: string; productName: string; accentColor: string; promptLogging: boolean };
  workspaces: { id: string; name: string; icon: string | null; role: WorkspaceRole; sections: Section[] }[];
  unreadNotifications: number;
}

export interface PublicStatus {
  setupRequired: boolean;
  org: { name: string | null; productName: string; accentColor: string; loginMessage: string | null };
}

export interface QuotaStatus {
  period: "day" | "week" | "month";
  periodStart: string;
  resetsAt: string;
  user: { limit: number | null; bonus: number; used: number; isOverride: boolean };
  workspace: { limit: number | null; bonus: number; used: number };
  result: QuotaResult;
}

export interface AvailableModel {
  id: string;
  displayName: string;
  modelKey: string;
  providerName: string;
  providerType: string;
  contextLength: number | null;
  isDefault: boolean;
}

export interface ChatSummary {
  id: string;
  title: string;
  pinned: boolean;
  modelId: string | null;
  updatedAt: string;
}

export interface ChatMessageRow {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  modelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
  createdAt: string;
}

export interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface TokenRequestRow {
  id: string;
  workspaceId: string;
  userId: string;
  amount: number;
  duration: "period" | "permanent";
  reason: string | null;
  status: "pending" | "approved" | "denied";
  decidedAmount: number | null;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
  userName: string;
  userEmail: string;
  workspaceName: string;
  quota?: QuotaStatus;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  icon: string | null;
  description: string | null;
  tokenLimit: number | null;
  defaultModelId: string | null;
  memberCount: number;
  modelCount: number;
  used: number;
  pendingRequests: number;
}
