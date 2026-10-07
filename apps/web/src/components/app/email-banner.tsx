"use client";

import { useQueryClient } from "@tanstack/react-query";
import { MailWarning, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useSession } from "@/components/app/session";
import { useSendConfirmation } from "@/components/settings/security";

const HIDE_KEY = "aatmiq.email-banner-hidden";

const LINK_ERRORS: Record<string, string> = {
  TOKEN_EXPIRED: "That confirmation link expired. Send yourself a new one.",
  INVALID_TOKEN: "That confirmation link isn't valid. Send yourself a new one.",
};

/** Asks people to confirm their email address, and reports the result of a confirmation link. */
export function EmailBanner() {
  const { me } = useSession();
  const qc = useQueryClient();
  const send = useSendConfirmation();
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    try {
      setHidden(sessionStorage.getItem(HIDE_KEY) === "1");
    } catch {
      setHidden(false);
    }
    // The link in the email lands on /app?email_verified=1 (Better Auth adds &error=… when it fails).
    const url = new URL(window.location.href);
    if (!url.searchParams.has("email_verified")) return;
    const error = url.searchParams.get("error");
    if (error) toast.error(LINK_ERRORS[error] ?? "That confirmation link didn't work. Send yourself a new one.");
    else {
      toast.success("Your email address is confirmed");
      void qc.invalidateQueries({ queryKey: ["me"] });
    }
    url.searchParams.delete("email_verified");
    url.searchParams.delete("error");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, [qc]);

  if (me.user.emailVerified || !me.emailEnabled || hidden) return null;
  return (
    <div className="flex items-center justify-center gap-2 border-b border-border px-4 py-1.5 text-center text-xs text-fg-muted" data-testid="email-banner">
      <MailWarning className="size-3.5 shrink-0 text-warning" />
      <span>Confirm {me.user.email} so password resets and notices reach you.</span>
      <button type="button" className="shrink-0 underline underline-offset-2 hover:text-fg disabled:opacity-60" disabled={send.isPending} onClick={() => send.mutate()} data-testid="email-banner-send">
        {send.isPending ? "Sending…" : "Send link"}
      </button>
      <button
        type="button"
        aria-label="Hide for now"
        className="ml-1 shrink-0 rounded p-0.5 hover:bg-surface-2 hover:text-fg"
        onClick={() => {
          setHidden(true);
          try {
            sessionStorage.setItem(HIDE_KEY, "1");
          } catch {}
        }}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
