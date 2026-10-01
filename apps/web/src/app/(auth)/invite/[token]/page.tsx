"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AuthShell, FormError, usePublicStatus } from "@/components/auth-shell";
import { SsoButtons, useSsoOptions } from "@/components/sso-buttons";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { api, get } from "@/lib/api";

export default function InvitePage() {
  return (
    <Suspense>
      <Invite />
    </Suspense>
  );
}

function Invite() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const invite = useQuery({
    queryKey: ["invite", token],
    queryFn: () => get<{ email: string; orgName: string; productName: string }>(`/api/invites/${token}`),
    retry: false,
  });
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(useSearchParams().get("sso_error"));
  const sso = useSsoOptions();
  const { data: status } = usePublicStatus();
  const options = sso.data ?? [];
  const passwordAllowed = !status?.ssoRequired || !options.length;
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api(`/api/invites/${token}/accept`, { method: "POST", json: { name, password } });
      router.replace("/app");
    } catch (err: any) {
      setError(err?.message ?? "Could not accept the invitation.");
      setLoading(false);
    }
  }

  if (invite.isLoading)
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  if (invite.isError)
    return (
      <AuthShell title="Invitation not valid" subtitle="This link has expired or was already used. Ask your admin to send a new one." footer={<a href="/login" className="text-fg underline underline-offset-4">Go to sign in</a>}>
        <span />
      </AuthShell>
    );

  return (
    <AuthShell title={`Join ${invite.data!.orgName}`} subtitle={<>You were invited as <span className="text-fg">{invite.data!.email}</span></>}>
      {options.length > 0 && <SsoButtons options={options} invite={token} email={invite.data!.email} next="/app" />}
      {options.length > 0 && passwordAllowed && (
        <div className="my-6 flex items-center gap-3 text-xs text-fg-subtle">
          <span className="h-px flex-1 bg-border" /> or create a password <span className="h-px flex-1 bg-border" />
        </div>
      )}
      {!passwordAllowed && <div className="mt-4"><FormError message={error} /></div>}
      {passwordAllowed && (
      <form onSubmit={submit} className="space-y-4">
        <Field label="Your name">
          <Input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
        </Field>
        <Field label="Create a password" hint="At least 10 characters.">
          <Input type="password" required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <FormError message={error} />
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading}>
          Join workspace
        </Button>
      </form>
      )}
    </AuthShell>
  );
}
