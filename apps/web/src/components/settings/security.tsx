"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, LogOut, Mail, Monitor, ShieldCheck, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Badge, Card } from "@/components/ui/misc";
import { Dialog } from "@/components/ui/overlay";
import { Spinner } from "@/components/ui/spinner";
import { api, del, get, post } from "@/lib/api";
import { timeAgo } from "@/lib/format";

interface Security {
  hasPassword: boolean;
  passwordAllowed: boolean;
  twoFactorEnabled: boolean;
  twoFactorRequired: boolean;
  email: string;
  emailVerified: boolean;
  otherSessions: number;
  emailEnabled: boolean;
}

/** Settings → Security: password, two-step sign-in and other devices. */
export function SecuritySettings() {
  const q = useQuery({ queryKey: ["me-security"], queryFn: () => get<Security>("/api/me/security") });
  if (!q.data) return <Spinner className="size-4" />;
  const s = q.data;
  const usesPassword = s.hasPassword && s.passwordAllowed;
  return (
    <div className="space-y-5">
      {!usesPassword && (
        <Card className="p-4 text-[13px] text-fg-muted">
          You sign in with your organization&apos;s single sign-on, so your password and two-step sign-in are managed there.
        </Card>
      )}
      <EmailAddress email={s.email} verified={s.emailVerified} emailEnabled={s.emailEnabled} />
      {usesPassword && <ChangePassword />}
      {usesPassword && <TwoStep enabled={s.twoFactorEnabled} required={s.twoFactorRequired} />}
      <OtherDevices count={s.otherSessions} />
    </div>
  );
}

function Section({ icon: Icon, title, description, aside, children }: { icon: typeof KeyRound; title: string; description: string; aside?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <Card className="p-5">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[14px] text-fg">
            {title}
            {aside}
          </div>
          <p className="mt-0.5 text-[12.5px] text-fg-subtle">{description}</p>
          {children && <div className="mt-4">{children}</div>}
        </div>
      </div>
    </Card>
  );
}

/** Sends a link that confirms the person's address. */
export function useSendConfirmation() {
  return useMutation({
    mutationFn: () => post<{ to?: string; alreadyVerified?: boolean }>("/api/me/email/verify"),
    onSuccess: (r) => (r.alreadyVerified ? toast.success("Your email is already confirmed") : toast.success(`Link sent to ${r.to}. It works for 24 hours.`)),
    onError: (e: Error) => toast.error(e.message),
  });
}

function EmailAddress({ email, verified, emailEnabled }: { email: string; verified: boolean; emailEnabled: boolean }) {
  const send = useSendConfirmation();
  return (
    <Section
      icon={Mail}
      title="Email address"
      description={
        verified
          ? `${email} is confirmed.`
          : emailEnabled
            ? `Confirm ${email} so password resets and notices reach you.`
            : `${email} isn't confirmed yet. You can confirm it once your admin sets up email.`
      }
      aside={verified ? <Badge tone="success">Confirmed</Badge> : <Badge>Not confirmed</Badge>}
    >
      {!verified && emailEnabled && (
        <Button onClick={() => send.mutate()} loading={send.isPending} data-testid="send-confirmation">
          Send confirmation link
        </Button>
      )}
    </Section>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () => api("/api/auth/change-password", { method: "POST", json: { currentPassword: current, newPassword: next, revokeOtherSessions: true } }),
    onSuccess: () => {
      toast.success("Password changed. Other devices were signed out.");
      setCurrent("");
      setNext("");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["me-security"] });
    },
    onError: (e: Error & { status?: number }) => toast.error(/invalid password/i.test(e.message) ? "Your current password isn't right." : e.message),
  });
  return (
    <Section icon={KeyRound} title="Password" description="Changing it signs you out on your other devices.">
      {open ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Current password">
            <Input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} data-testid="current-password" />
          </Field>
          <Field label="New password" hint="At least 10 characters.">
            <Input type="password" autoComplete="new-password" required minLength={10} maxLength={128} value={next} onChange={(e) => setNext(e.target.value)} data-testid="new-password" />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={save.isPending}>
              Change password
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button onClick={() => setOpen(true)} data-testid="change-password">
          Change password
        </Button>
      )}
    </Section>
  );
}

/** Asks for the password before a two-step sign-in change (Better Auth requires it). */
function PasswordPrompt({ open, title, description, action, danger, onClose, onConfirm }: { open: boolean; title: string; description: string; action: string; danger?: boolean; onClose: () => void; onConfirm: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) (setPassword(""), setError(null));
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={title} description={description}>
      <form
        className="space-y-3 px-5 pb-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await onConfirm(password);
          } catch (err) {
            setError(/password/i.test((err as Error).message) ? "That password isn't right." : (err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Your password" error={error}>
          <Input type="password" autoComplete="current-password" autoFocus required value={password} onChange={(e) => setPassword(e.target.value)} data-testid="confirm-with-password" />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={danger ? "danger" : "primary"} loading={busy} data-testid="password-prompt-submit">
            {action}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function TwoStep({ enabled, required }: { enabled: boolean; required: boolean }) {
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState<null | "enable" | "disable" | "codes">(null);
  const [setup, setSetup] = useState<{ uri: string; backupCodes: string[] } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["me-security"] });

  return (
    <Section
      icon={Smartphone}
      title="Two-step sign-in"
      description="After your password, enter a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…)."
      aside={enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
    >
      <div className="flex flex-wrap gap-2">
        {enabled ? (
          <>
            <Button onClick={() => setPrompt("codes")} data-testid="new-backup-codes">
              New backup codes
            </Button>
            {required ? (
              <span className="self-center text-[12.5px] text-fg-subtle">Your organization requires it, so it can&apos;t be turned off.</span>
            ) : (
              <Button variant="ghost" onClick={() => setPrompt("disable")} data-testid="two-factor-off">
                Turn off
              </Button>
            )}
          </>
        ) : (
          <Button variant="primary" onClick={() => setPrompt("enable")} data-testid="two-factor-on">
            Set up
          </Button>
        )}
      </div>
      <PasswordPrompt
        open={prompt === "enable"}
        title="Set up two-step sign-in"
        description="Confirm it's you first."
        action="Continue"
        onClose={() => setPrompt(null)}
        onConfirm={async (password) => {
          const r = await post<{ totpURI: string; backupCodes: string[] }>("/api/auth/two-factor/enable", { password });
          setPrompt(null);
          setSetup({ uri: r.totpURI, backupCodes: r.backupCodes });
        }}
      />
      <PasswordPrompt
        open={prompt === "disable"}
        title="Turn off two-step sign-in?"
        description="Your password alone will sign you in again."
        action="Turn off"
        danger
        onClose={() => setPrompt(null)}
        onConfirm={async (password) => {
          await post("/api/auth/two-factor/disable", { password });
          setPrompt(null);
          toast.success("Two-step sign-in is off");
          refresh();
        }}
      />
      <PasswordPrompt
        open={prompt === "codes"}
        title="Make new backup codes?"
        description="Your old backup codes stop working."
        action="Make new codes"
        onClose={() => setPrompt(null)}
        onConfirm={async (password) => {
          const r = await post<{ backupCodes: string[] }>("/api/auth/two-factor/generate-backup-codes", { password });
          setPrompt(null);
          setCodes(r.backupCodes);
        }}
      />
      {setup && (
        <SetupDialog
          uri={setup.uri}
          backupCodes={setup.backupCodes}
          onClose={() => {
            setSetup(null);
            refresh();
          }}
        />
      )}
      {codes && (
        <Dialog open onOpenChange={(o) => !o && setCodes(null)} title="Your new backup codes" description="Each one works once, if you can't use your phone. Keep them somewhere safe.">
          <div className="px-5 pb-5">
            <BackupCodes codes={codes} />
            <div className="mt-4 flex justify-end">
              <Button variant="primary" onClick={() => setCodes(null)}>
                Done
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </Section>
  );
}

/** The setup flow alone, for the page shown when the organization requires two-step sign-in. */
export function RequiredTwoStepSetup({ onDone }: { onDone: () => void }) {
  const [asking, setAsking] = useState(false);
  const [setup, setSetup] = useState<{ uri: string; backupCodes: string[] } | null>(null);
  return (
    <>
      <Button variant="primary" size="lg" className="w-full" onClick={() => setAsking(true)} data-testid="two-factor-on">
        Set up two-step sign-in
      </Button>
      <PasswordPrompt
        open={asking}
        title="Set up two-step sign-in"
        description="Confirm it's you first."
        action="Continue"
        onClose={() => setAsking(false)}
        onConfirm={async (password) => {
          const r = await post<{ totpURI: string; backupCodes: string[] }>("/api/auth/two-factor/enable", { password });
          setAsking(false);
          setSetup({ uri: r.totpURI, backupCodes: r.backupCodes });
        }}
      />
      {setup && <SetupDialog uri={setup.uri} backupCodes={setup.backupCodes} onClose={() => setSetup(null)} onDone={onDone} />}
    </>
  );
}

function SetupDialog({ uri, backupCodes, onClose, onDone = onClose }: { uri: string; backupCodes: string[]; onClose: () => void; onDone?: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"scan" | "codes">("scan");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  useEffect(() => {
    QRCode.toDataURL(uri, { margin: 1, width: 200, errorCorrectionLevel: "M" }).then(setQr, () => setQr(null));
  }, [uri]);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/api/auth/two-factor/verify-totp", { code: code.replace(/\s/g, "") });
      setStep("codes");
    } catch {
      setError("That code isn't right. Enter the newest code from the app.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && step === "codes" && onDone()}
      title={step === "scan" ? "Scan with your authenticator app" : "Save your backup codes"}
      description={step === "scan" ? "Then enter the 6-digit code it shows." : "Two-step sign-in is on. If you lose your phone, each of these codes signs you in once."}
    >
      <div className="px-5 pb-5">
        {step === "scan" ? (
          <form onSubmit={verify} className="space-y-4">
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-xl bg-white p-2">{qr ? <img src={qr} alt="QR code for your authenticator app" className="size-[180px]" /> : <div className="size-[180px]" />}</div>
              <details className="w-full text-[12px] text-fg-subtle">
                <summary className="cursor-pointer text-center hover:text-fg">Can&apos;t scan? Enter this key instead</summary>
                <code className="mt-2 block rounded-md bg-surface-2 px-2 py-1.5 text-center font-mono text-[12px] break-all text-fg" data-testid="totp-secret">
                  {secret.replace(/(.{4})/g, "$1 ").trim()}
                </code>
              </details>
            </div>
            <Field label="Code from the app" error={error}>
              <Input autoFocus required inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123 456" value={code} onChange={(e) => setCode(e.target.value)} className="font-mono tracking-[0.2em]" data-testid="setup-code" />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={busy} data-testid="setup-verify">
                Turn on
              </Button>
            </div>
          </form>
        ) : (
          <>
            <BackupCodes codes={backupCodes} />
            <div className="mt-4 flex justify-end">
              <Button variant="primary" onClick={onDone} data-testid="setup-done">
                I saved them
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

function BackupCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-border bg-surface-2 p-3 font-mono text-[13px] text-fg" data-testid="backup-codes">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <button
        type="button"
        className="mt-2 inline-flex items-center gap-1.5 text-[12px] text-fg-subtle hover:text-fg"
        onClick={() => {
          void navigator.clipboard.writeText(codes.join("\n")).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy codes"}
      </button>
    </div>
  );
}

interface Device {
  id: string;
  device: string;
  ip: string | null;
  signedInAt: string;
  lastActiveAt: string;
  current: boolean;
}

/** Where you're signed in, with sign-out for any other device (or all of them). */
function OtherDevices({ count }: { count: number }) {
  const qc = useQueryClient();
  const devices = useQuery({ queryKey: ["me-sessions", count], queryFn: () => get<Device[]>("/api/me/sessions") });
  const done = (msg: string) => {
    toast.success(msg);
    qc.invalidateQueries({ queryKey: ["me-security"] });
    qc.invalidateQueries({ queryKey: ["me-sessions"] });
  };
  const outOne = useMutation({ mutationFn: (id: string) => del(`/api/me/sessions/${id}`), onSuccess: () => done("Signed out on that device"), onError: (e: Error) => toast.error(e.message) });
  const outAll = useMutation({ mutationFn: () => post("/api/me/sessions/revoke-others", {}), onSuccess: () => done("Signed out on your other devices"), onError: (e: Error) => toast.error(e.message) });
  const others = devices.data?.filter((d) => !d.current).length ?? count;
  return (
    <Section
      icon={others ? LogOut : ShieldCheck}
      title="Signed-in devices"
      description={others ? `You're signed in here and on ${others === 1 ? "1 other device" : `${others} other devices`}. Sign out of any you don't recognise.` : "You're only signed in here."}
    >
      <ul className="divide-y divide-border rounded-lg border border-border" data-testid="devices">
        {(devices.data ?? []).map((d) => (
          <li key={d.id} className="flex items-center gap-3 px-3 py-2.5 text-sm" data-testid="device">
            <Monitor className="size-4 shrink-0 text-fg-subtle" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate">{d.device}</span>
                {d.current && <Badge tone="success">This device</Badge>}
              </div>
              <div className="text-xs text-fg-subtle">
                {d.current ? "Active now" : `Last active ${timeAgo(d.lastActiveAt)}`}
                {d.ip ? ` · ${d.ip}` : ""} · signed in {timeAgo(d.signedInAt)}
              </div>
            </div>
            {!d.current && (
              <Button variant="ghost" size="sm" onClick={() => outOne.mutate(d.id)} loading={outOne.isPending && outOne.variables === d.id} data-testid="device-sign-out">
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
      {others > 1 && (
        <Button className="mt-3" onClick={() => outAll.mutate()} loading={outAll.isPending} data-testid="sign-out-others">
          Sign out everywhere else
        </Button>
      )}
    </Section>
  );
}
