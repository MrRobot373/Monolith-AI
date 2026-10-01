"use client";

import { Button } from "@aatmiq/ui/button";
import { Field, Input } from "@aatmiq/ui/field";
import { LogoMark } from "@aatmiq/ui/logo";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api("/api/auth/login", { method: "POST", json: { email, password } });
      router.replace("/");
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-[380px] animate-rise">
        <div className="mb-6 flex items-center justify-center gap-2">
          <LogoMark className="size-6" />
          <span className="text-[15px] text-fg">Aatmiq licensing</span>
        </div>
        <div className="rounded-2xl border border-border bg-bg p-6 shadow-soft">
          <h1 className="font-serif text-[26px] leading-tight tracking-[-0.02em]">Super Admin</h1>
          <p className="mt-1 text-[13px] text-fg-subtle">Customers, licenses and check-ins. No customer content is ever stored here.</p>
          <form onSubmit={submit} className="mt-6 space-y-4">
            <Field label="Email">
              <Input type="email" autoFocus required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Password">
              <Input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {error && <div className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">{error}</div>}
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
              Sign in
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
