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
    <div className="relative flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 py-12">
      <div className="relative w-full max-w-[400px] animate-rise">
        <Link href="/" className="mb-6 flex items-center justify-center gap-2" aria-label={`${product} home`}>
          <LogoMark className="size-7" />
          <span className="text-[14px] text-fg">{data?.org.name || product}</span>
        </Link>
        <div className="rounded-2xl border border-border bg-bg p-7 shadow-soft">
          <h1 className="text-center font-serif text-[30px] leading-tight tracking-[-0.02em]">{title}</h1>
          {subtitle && <p className="mt-2 text-center text-[13px] text-fg-subtle">{subtitle}</p>}
          <div className="mt-7">{children}</div>
        </div>
        {data?.org.loginMessage && (
          <p className="mt-4 text-center text-xs text-fg-subtle">{data.org.loginMessage}</p>
        )}
        {footer && <div className="mt-5 text-center text-[13px] text-fg-subtle">{footer}</div>}
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
