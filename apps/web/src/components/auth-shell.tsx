"use client";

import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, type ReactNode } from "react";
import { LogoMark } from "@/components/ui/logo";
import { get } from "@/lib/api";
import { applyAccent } from "@/lib/theme";
import type { PublicStatus } from "@/lib/types";

export function usePublicStatus() {
  const q = useQuery({ queryKey: ["public-status"], queryFn: () => get<PublicStatus>("/api/public/status") });
  useEffect(() => applyAccent(q.data?.org.accentColor), [q.data?.org.accentColor]);
  return q;
}

export function AuthShell({ title, subtitle, children, footer }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const { data } = usePublicStatus();
  const product = data?.org.productName ?? "Aatmiq";
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[420px] bg-[radial-gradient(50%_60%_at_50%_0%,color-mix(in_oklab,var(--accent)_12%,transparent),transparent)]" />
      <div className="relative w-full max-w-[380px] animate-rise">
        <Link href="/" className="mb-8 flex flex-col items-center gap-3" aria-label={`${product} home`}>
          <LogoMark className="size-10" />
          {data?.org.name && <span className="text-sm text-fg-muted">{data.org.name}</span>}
        </Link>
        <h1 className="text-center text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-2 text-center text-sm text-fg-muted">{subtitle}</p>}
        <div className="mt-8">{children}</div>
        {data?.org.loginMessage && (
          <p className="mt-6 rounded-lg border border-border bg-surface px-3 py-2 text-center text-xs text-fg-muted">{data.org.loginMessage}</p>
        )}
        {footer && <div className="mt-8 text-center text-sm text-fg-muted">{footer}</div>}
      </div>
      <p className="absolute bottom-5 flex items-center gap-1.5 text-xs text-fg-subtle">
        <ShieldCheck className="size-3.5" /> Private deployment · your data stays on your servers
      </p>
    </div>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return <div className="animate-fade-in rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">{message}</div>;
}
