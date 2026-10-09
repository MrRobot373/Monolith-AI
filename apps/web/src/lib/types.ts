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
    emailVerified: boolean;
    /** The org requires two-step sign-in and it isn't set up yet: only the setup page works. */
    twoFactorSetupRequired: boolean;
    /** Two-step sign-in is required from this date and not set up yet. */
    twoFactorDue?: string | null;
  };
  /** Outgoing email is set up, so confirmation links can be sent. */
  emailEnabled: boolean;
  isAdmin: boolean;
  isWorkspaceAdmin: boolean;
  org: { name: string; productName: string; accentColor: string; promptLogging: boolean; logoUrl: string | null };
  workspaces: { id: string; name: string; icon: string | null; role: WorkspaceRole; sections: Section[] }[];
  unreadNotifications: number;
  license?: {
    state: string;
    canUse: boolean;
    tier: string | null;
    sections: string[];
    features: string[] | null;
    message: string | null;
  };
}

export interface PublicStatus {
  setupRequired: boolean;
  licenseRequired?: boolean;
  ssoRequired?: boolean;
  org: { name: string | null; productName: string; accentColor: string; loginMessage: string | null; logoUrl: string | null };
}

export interface QuotaStatus {
  /** Whose budget: the workspace's, or a group's (for a model only that group gives). */
  scope: { kind: "workspace" } | { kind: "group"; id: string; name: string };
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
  /** Groups that give this model when the workspace doesn't; their budget pays for it. */
  groups: { id: string; name: string }[];
}

export interface ChatSummary {
  id: string;
  title: string;
  pinned: boolean;
  modelId: string | null;
  projectId?: string | null;
  projectName?: string | null;
  sharedToProject?: boolean;
  archivedAt?: string | null;
  updatedAt: string;
}

export interface ChatDetail {
  id: string;
  userId: string;
  modelId: string | null;
  title: string;
  projectId: string | null;
  sharedToProject: boolean;
  archivedAt: string | null;
  temporary: boolean;
  leafMessageId: string | null;
  messages: ChatMessageRow[];
  documents: { id: string; name: string }[];
  readOnly: boolean;
  authorName: string | null;
  project: { id: string; name: string; color: string; canEdit: boolean } | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  color: string;
  description: string | null;
  visibility: "private" | "workspace";
  ownerId: string | null;
  updatedAt: string;
  chatCount: number;
  sourceCount: number;
  memberCount: number;
}

export interface ProjectSource {
  id: string;
  name: string;
  kind: "file" | "note" | "answer";
  status: "processing" | "ready" | "failed";
  error: string | null;
  sizeBytes: number;
  pageCount: number | null;
  label: SourceLabel | null;
  supersededById: string | null;
  projectOnly: boolean;
  addedAt: string;
}

export interface ProjectDetail {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
  description: string | null;
  instructions: string | null;
  visibility: "private" | "workspace";
  ownerId: string | null;
  role: "owner" | "edit" | "chat";
  canEdit: boolean;
  owner: { id: string; name: string; email: string } | null;
  sources: ProjectSource[];
  members: { userId: string; name: string; email: string; image: string | null; role: "chat" | "edit" }[];
  chats: { id: string; title: string; updatedAt: string; userId: string; userName: string; sharedToProject: boolean; pinned: boolean }[];
  /** Work AI tasks in the project: the reader's own and those shared to it. */
  tasks: { id: string; title: string; status: import("./work").TaskStatus; updatedAt: string; userId: string; userName: string; sharedToProject: boolean; scheduleId: string | null }[];
  /** Connectors its Work AI tasks may use; null: all. */
  connectorIds: string[] | null;
}

export interface Person {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface SearchResults {
  chats: { id: string; title: string; projectId: string | null; projectName: string | null; archived: boolean; updatedAt: string; snippet: string | null }[];
  documents: { id: string; name: string; projectId: string | null }[];
  projects: { id: string; name: string; color: string }[];
}

export interface ChatMessageRow {
  id: string;
  parentId?: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  modelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
  attachments?: { id: string; name: string }[] | null;
  citations?: Citation[] | null;
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

export interface DocumentRow {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  scope: "private" | "workspace";
  status: "processing" | "ready" | "failed";
  error: string | null;
  pageCount: number | null;
  chunkCount: number | null;
  label?: SourceLabel | null;
  ownerId: string | null;
  ownerName: string | null;
  createdAt: string;
}

export interface Citation {
  n: number;
  kind?: "document" | "chat" | "task";
  documentId: string | null;
  chatId?: string;
  taskId?: string;
  name: string;
  page: number | null;
  snippet: string;
  label?: SourceLabel | null;
}

export type SourceLabel = "confirmed" | "assumption" | "tbd";
