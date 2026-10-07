import { APPROVAL_PRESETS, type CatalogCategory } from "@aatmiq/shared";
import { BookOpen, Code2, CreditCard, Database, FileText, ListChecks, Mail, MessageSquare, Palette, Plug, Users } from "lucide-react";
import { cn } from "@/lib/cn";

const ICONS: Record<CatalogCategory, typeof Plug> = {
  "Email & calendar": Mail,
  "Files & docs": FileText,
  Design: Palette,
  "Chat & meetings": MessageSquare,
  "Projects & tasks": ListChecks,
  "CRM & support": Users,
  "Payments & commerce": CreditCard,
  Developer: Code2,
  Data: Database,
  Knowledge: BookOpen,
};

/** A connector's tile: its category's icon (custom servers get a plug). */
export function ConnectorIcon({ category, className }: { category?: string | null; className?: string }) {
  const Icon = (category && ICONS[category as CatalogCategory]) || Plug;
  return (
    <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-bg", className)}>
      <Icon className="size-4 text-fg-muted" />
    </span>
  );
}

export type ApprovalPreset = "changes" | "all" | "none" | "custom";

export function approvalPresetOf(rule: string): ApprovalPreset {
  if (rule === APPROVAL_PRESETS.all) return "all";
  if (rule === APPROVAL_PRESETS.none) return "none";
  if (rule === APPROVAL_PRESETS.changes) return "changes";
  return "custom";
}

export const APPROVAL_LABELS: Record<ApprovalPreset, string> = {
  changes: "Ask before changes (reading runs freely)",
  all: "Ask before every action",
  none: "Never ask",
  custom: "Custom rule",
};

export function approvalSummary(rule: string) {
  const p = approvalPresetOf(rule);
  if (p === "changes") return "asks before changes";
  if (p === "all") return "asks before every action";
  if (p === "none") return "never asks";
  return `asks before: ${rule}`;
}

export const AUTH_LABELS = { oauth: "Each person signs in", token: "Shared token", none: "No sign-in" } as const;
