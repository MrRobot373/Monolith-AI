"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthShell, FormError, usePublicStatus } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { applyAccent } from "@/lib/theme";

const ACCENTS = ["#22D3EE", "#60A5FA", "#A78BFA", "#34D399", "#FBBF24", "#F472B6", "#FAFAFA"];

export default function SetupPage() {
  const router = useRouter();
  const { data: status } = usePublicStatus();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({ orgName: "", name: "", email: "", password: "", accentColor: "#22D3EE", licenseKey: "" });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (status && !status.setupRequired) router.replace("/login");
  }, [status, router]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (step === 0) return setStep(1);
    setLoading(true);
    setError(null);
    try {
      await api("/api/setup", { method: "POST", json: { ...form, licenseKey: form.licenseKey || undefined } });
      router.replace("/app");
    } catch (err: any) {
      setError(err?.message ?? "Setup failed.");
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title={step === 0 ? "Welcome to Aatmiq" : "Create the owner account"}
      subtitle={step === 0 ? "Let's set up your organization's private AI workspace." : "You'll be the owner and first admin."}
    >
      <div className="mb-6 flex justify-center gap-1.5">
        {[0, 1].map((i) => (
          <span key={i} className={cn("h-1 rounded-full transition-all duration-300", i === step ? "w-6 bg-fg" : "w-3 bg-surface-3")} />
        ))}
      </div>
      <form onSubmit={submit} className="space-y-4">
        {step === 0 ? (
          <div key="s0" className="animate-rise space-y-4">
            <Field label="Organization name">
              <Input autoFocus required minLength={2} value={form.orgName} onChange={set("orgName")} placeholder="Acme Labs" />
            </Field>
            <Field label="Accent color" hint="Used for highlights across the product. You can change it later.">
              <div className="flex gap-2 pt-1">
                {ACCENTS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Accent ${c}`}
                    onClick={() => {
                      setForm((f) => ({ ...f, accentColor: c }));
                      applyAccent(c);
                    }}
                    className={cn(
                      "size-7 rounded-full border-2 transition-transform hover:scale-110",
                      form.accentColor === c ? "scale-110 border-fg" : "border-transparent",
                    )}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </Field>
            <Field label="License key" hint="Optional for evaluation. Paste the key from your Aatmiq order.">
              <Input value={form.licenseKey} onChange={set("licenseKey")} placeholder="aatmiq_lic_…" />
            </Field>
          </div>
        ) : (
          <div key="s1" className="animate-rise space-y-4">
            <Field label="Your name">
              <Input autoFocus required value={form.name} onChange={set("name")} placeholder="Asha Rao" />
            </Field>
            <Field label="Work email">
              <Input type="email" required autoComplete="email" value={form.email} onChange={set("email")} placeholder="asha@acme.com" />
            </Field>
            <Field label="Password" hint="At least 10 characters.">
              <Input type="password" required minLength={10} autoComplete="new-password" value={form.password} onChange={set("password")} />
            </Field>
          </div>
        )}
        <FormError message={error} />
        <div className="flex gap-2">
          {step === 1 && (
            <Button type="button" variant="outline" size="lg" onClick={() => setStep(0)}>
              Back
            </Button>
          )}
          <Button type="submit" variant="primary" size="lg" className="flex-1" loading={loading}>
            {step === 0 ? "Continue" : "Create workspace"}
          </Button>
        </div>
      </form>
    </AuthShell>
  );
}
