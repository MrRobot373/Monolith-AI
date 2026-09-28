"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AuthShell, FormError, usePublicStatus } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { api } from "@/lib/api";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { data: status } = usePublicStatus();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email">
          <Input type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••" />
        </Field>
        <FormError message={error} />
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
          Continue
        </Button>
      </form>
      <div className="my-6 flex items-center gap-3 text-xs text-fg-subtle">
        <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
      </div>
      <div className="grid gap-2">
        <Button variant="outline" disabled className="w-full" title="Configured by your admin (coming soon)">
          Continue with Google
        </Button>
        <Button variant="outline" disabled className="w-full" title="Configured by your admin (coming soon)">
          Continue with Microsoft
        </Button>
        <p className="text-center text-[11.5px] text-fg-subtle">Single sign-on is set up by your admin.</p>
      </div>
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
