"use client";

import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useSession } from "@/components/app/session";
import { cn } from "@/lib/cn";

export const LICENSE_STATE: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  development: { label: "Development", tone: "neutral" },
  missing: { label: "No license", tone: "danger" },
  invalid: { label: "Invalid key", tone: "danger" },
  valid: { label: "Active", tone: "success" },
  check_in_overdue: { label: "Check-in overdue", tone: "warning" },
  admin_locked: { label: "Admin paused", tone: "warning" },
  expiring_grace: { label: "Expired · grace period", tone: "warning" },
  expired: { label: "Expired", tone: "danger" },
  revoked: { label: "Revoked", tone: "danger" },
};

/** A thin strip above the app when the license needs attention. */
export function LicenseBanner({ className }: { className?: string }) {
  const { me } = useSession();
  const l = me.license;
  if (!l?.message) return null;
  const serious = !l.canUse || ["expired", "revoked", "missing", "invalid", "admin_locked"].includes(l.state);
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-2 border-b px-4 py-1.5 text-center text-xs",
        serious ? "border-danger/30 bg-danger-soft text-danger" : "border-border text-warning",
        className,
      )}
      data-testid="license-banner"
    >
      <TriangleAlert className="size-3.5 shrink-0" />
      <span>{l.message}</span>
      {me.isAdmin && (
        <Link href="/admin/license" className="shrink-0 underline underline-offset-2">
          Open license
        </Link>
      )}
    </div>
  );
}
