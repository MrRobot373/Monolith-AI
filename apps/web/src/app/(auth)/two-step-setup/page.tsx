"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AuthShell } from "@/components/auth-shell";
import { useMe } from "@/components/app/session";
import { RequiredTwoStepSetup } from "@/components/settings/security";
import { Spinner } from "@/components/ui/spinner";
import { ApiError, post } from "@/lib/api";

/** Shown instead of the app while the organization requires two-step sign-in and it isn't set up. */
export default function TwoStepSetupPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data: me, error } = useMe();

  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) router.replace("/login");
    else if (me && !me.user.twoFactorSetupRequired) router.replace("/app");
  }, [me, error, router]);

  const signOut = async () => {
    await post("/api/auth/sign-out").catch(() => {});
    qc.clear();
    router.replace("/login");
  };

  if (!me?.user.twoFactorSetupRequired)
    return (
      <div className="flex min-h-dvh items-center justify-center text-fg-subtle">
        <Spinner />
      </div>
    );

  return (
    <AuthShell
      title="Set up two-step sign-in"
      subtitle={`${me.org.name || "Your organization"} requires a code from an authenticator app after your password. It takes about a minute.`}
      footer={
        <button type="button" onClick={signOut} className="hover:text-fg">
          Sign out
        </button>
      }
    >
      <ol className="mb-5 list-decimal space-y-1.5 pl-5 text-[13px] text-fg-muted">
        <li>Install an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password…).</li>
        <li>Scan the QR code, then enter the 6-digit code it shows.</li>
        <li>Save your backup codes somewhere safe.</li>
      </ol>
      <RequiredTwoStepSetup
        onDone={async () => {
          await qc.invalidateQueries({ queryKey: ["me"] });
          router.replace("/app");
        }}
      />
    </AuthShell>
  );
}
