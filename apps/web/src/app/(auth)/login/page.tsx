"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AuthShell, FormError, usePublicStatus } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { SsoButtons, useSsoOptions } from "@/components/sso-buttons";
import { api } from "@/lib/api";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { data: status } = usePublicStatus();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(params.get("sso_error"));
  const [loading, setLoading] = useState(false);
  const sso = useSsoOptions();
  const options = sso.data ?? [];
  // With SSO required, the password form is only for the owner (break-glass), behind a link.
  const [showPassword, setShowPassword] = useState(false);
  const passwordVisible = !status?.ssoRequired || !options.length || showPassword;
  const next = params.get("next");

  useEffect(() => {
    if (status?.setupRequired) router.replace("/setup");
  }, [status, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api("/api/auth/sign-in/email", { method: "POST", json: { email, password } });
      const next = params.get("next");
      router.replace(next && next.startsWith("/") ? next : "/app");
    } catch (err: any) {
      setError(err?.status === 401 ? "That email and password don't match." : err?.status === 403 ? "Your account is deactivated. Contact your admin." : (err?.message ?? "Sign-in failed."));
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title={`Sign in to ${status?.org.productName ?? "Aatmiq"}`}
      subtitle="Use the work email your admin invited."
      footer={<>No account? Ask your workspace admin for an invite.</>}
    >
      {options.length > 0 && <SsoButtons options={options} next={next} />}
      {options.length > 0 && passwordVisible && (
        <div className="my-6 flex items-center gap-3 text-xs text-fg-subtle">
          <span className="h-px flex-1 bg-border" /> or use your password <span className="h-px flex-1 bg-border" />
        </div>
      )}
      {passwordVisible ? (
        <form onSubmit={submit} className="space-y-4">
          <Field label="Email">
            <Input type="email" autoComplete="email" autoFocus={!options.length} required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </Field>
          <Field label="Password">
            <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••" />
          </Field>
          <FormError message={error} />
          <Button type="submit" variant={options.length ? "outline" : "primary"} size="lg" className="w-full" loading={loading}>
            Continue
          </Button>
        </form>
      ) : (
        <div className="mt-4 space-y-3">
          <FormError message={error} />
          <button type="button" onClick={() => setShowPassword(true)} className="block w-full text-center text-[12px] text-fg-subtle hover:text-fg">
            Organization owner? Sign in with a password
          </button>
        </div>
      )}
    </AuthShell>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
