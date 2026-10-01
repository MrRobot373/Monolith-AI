"use client";

import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { get } from "@/lib/api";
import { cn } from "@/lib/cn";

export interface SsoOption {
  id: string;
  type: "google" | "microsoft" | "oidc";
  name: string;
}

export function useSsoOptions() {
  return useQuery({ queryKey: ["public-sso"], queryFn: () => get<SsoOption[]>("/api/public/sso"), staleTime: 60_000 });
}

export function ProviderIcon({ type, className }: { type: SsoOption["type"]; className?: string }) {
  if (type === "google")
    return (
      <svg viewBox="0 0 24 24" className={cn("size-4", className)} aria-hidden>
        <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.7v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8z" />
        <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
        <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z" />
        <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
      </svg>
    );
  if (type === "microsoft")
    return (
      <svg viewBox="0 0 24 24" className={cn("size-4", className)} aria-hidden>
        <path fill="#F25022" d="M1 1h10.5v10.5H1z" />
        <path fill="#7FBA00" d="M12.5 1H23v10.5H12.5z" />
        <path fill="#00A4EF" d="M1 12.5h10.5V23H1z" />
        <path fill="#FFB900" d="M12.5 12.5H23V23H12.5z" />
      </svg>
    );
  return <KeyRound className={cn("size-4 text-fg-muted", className)} />;
}

/** "Continue with …" buttons. Each starts the provider's sign-in in this tab. */
export function SsoButtons({ options, next, invite, email }: { options: SsoOption[]; next?: string | null; invite?: string; email?: string }) {
  return (
    <div className="grid gap-2">
      {options.map((o) => {
        const q = new URLSearchParams();
        if (next) q.set("next", next);
        if (invite) q.set("invite", invite);
        if (email) q.set("email", email);
        return (
          <Button key={o.id} variant="outline" size="lg" className="w-full" asChild>
            <a href={`/api/auth/sso/${o.id}/start${q.size ? `?${q}` : ""}`} data-testid={`sso-${o.type}`}>
              <ProviderIcon type={o.type} /> Continue with {o.name}
            </a>
          </Button>
        );
      })}
    </div>
  );
}
