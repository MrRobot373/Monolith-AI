"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AuthShell, FormError, usePublicStatus } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { api } from "@/lib/api";

function ForgotForm() {
  const params = useSearchParams();
  const { data: status } = usePublicStatus();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api("/api/auth/request-password-reset", { method: "POST", json: { email, redirectTo: "/reset-password" } });
      setSent(true);
    } catch (err: any) {
      setError(err?.message ?? "Couldn't send the link. Try again.");
    } finally {
      setLoading(false);
    }
  }

  const back = (
    <Link href="/login" className="hover:text-fg">
      ← Back to sign in
    </Link>
  );

  if (sent)
    return (
      <AuthShell title="Check your email" subtitle={`If ${email} has an account, a link to choose a new password is on its way. It works once and expires in an hour.`} footer={back}>
        <p className="text-[13px] text-fg-muted" data-testid="reset-sent">
          Nothing arrived after a few minutes? Check spam, or ask your admin to send you a reset link.
        </p>
      </AuthShell>
    );

  return (
    <AuthShell title="Reset your password" subtitle="Enter your work email and we'll send you a link to choose a new password." footer={back}>
      {status?.ssoRequired && (
        <p className="mb-4 rounded-lg border border-border bg-surface-2 px-3 py-2 text-[12.5px] text-fg-muted">
          Your organization signs in with single sign-on, so only the owner has a password here.
        </p>
      )}
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <Input type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
        </Field>
        <FormError message={error} />
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
          Send reset link
        </Button>
      </form>
    </AuthShell>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense>
      <ForgotForm />
    </Suspense>
  );
}
