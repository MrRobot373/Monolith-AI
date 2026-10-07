"use client";

import Link from "next/link";
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
  // Two-step sign-in: the password was right and the account needs a code.
  const [step, setStep] = useState<"password" | "code">("password");

  useEffect(() => {
    if (status?.setupRequired) router.replace("/setup");
  }, [status, router]);

  function done() {
    router.replace(next && next.startsWith("/") ? next : "/app");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const r = await api<{ twoFactorRedirect?: boolean }>("/api/auth/sign-in/email", { method: "POST", json: { email, password } });
      if (r?.twoFactorRedirect) {
        setStep("code");
        setLoading(false);
        return;
      }
      done();
    } catch (err: any) {
      setError(err?.status === 401 ? "That email and password don't match." : err?.status === 403 ? "Your account is deactivated. Contact your admin." : (err?.message ?? "Sign-in failed."));
      setLoading(false);
    }
  }

  if (step === "code") return <CodeStep email={email} onDone={done} onBack={() => (setStep("password"), setPassword(""))} />;

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
          <Field
            label={
              <span className="flex items-center justify-between">
                Password
                <Link href={`/forgot-password${email ? `?email=${encodeURIComponent(email)}` : ""}`} className="font-normal text-fg-subtle hover:text-fg" data-testid="forgot-link">
                  Forgot password?
                </Link>
              </span>
            }
          >
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

/** The second step: a code from the authenticator app, or one of the backup codes. */
function CodeStep({ email, onDone, onBack }: { email: string; onDone: () => void; onBack: () => void }) {
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState("");
  const [trust, setTrust] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (backup) await api("/api/auth/two-factor/verify-backup-code", { method: "POST", json: { code: code.trim(), trustDevice: trust } });
      else await api("/api/auth/two-factor/verify-totp", { method: "POST", json: { code: code.replace(/\s/g, ""), trustDevice: trust } });
      onDone();
    } catch (err: any) {
      setLoading(false);
      if (err?.status === 401) setError(backup ? "That backup code isn't valid or was already used." : "That code isn't right. Check the time on your phone and try the newest code.");
      else if (err?.status === 403 || /expired|session/i.test(err?.message ?? "")) setError("This sign-in timed out. Go back and enter your password again.");
      else setError(err?.message ?? "Couldn't check the code.");
    }
  }

  return (
    <AuthShell title="Two-step sign-in" subtitle={backup ? "Enter one of the backup codes you saved." : `Open your authenticator app and enter the code for ${email}.`}>
      <form onSubmit={verify} className="space-y-4">
        <Field label={backup ? "Backup code" : "6-digit code"}>
          <Input
            key={backup ? "backup" : "totp"}
            autoFocus
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode={backup ? "text" : "numeric"}
            autoComplete="one-time-code"
            placeholder={backup ? "xxxxx-xxxxx" : "123 456"}
            maxLength={backup ? 24 : 7}
            className="font-mono tracking-[0.2em]"
            data-testid="two-factor-code"
          />
        </Field>
        <label className="flex items-center gap-2 text-[12.5px] text-fg-muted">
          <input type="checkbox" checked={trust} onChange={(e) => setTrust(e.target.checked)} className="accent-[var(--accent)]" />
          Don&apos;t ask again on this device for 30 days
        </label>
        <FormError message={error} />
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading} data-testid="two-factor-submit">
          Verify
        </Button>
      </form>
      <div className="mt-4 flex items-center justify-between text-[12px] text-fg-subtle">
        <button type="button" onClick={onBack} className="hover:text-fg">
          ← Back
        </button>
        <button type="button" onClick={() => (setBackup(!backup), setCode(""), setError(null))} className="hover:text-fg" data-testid="use-backup">
          {backup ? "Use the authenticator app" : "Use a backup code"}
        </button>
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
