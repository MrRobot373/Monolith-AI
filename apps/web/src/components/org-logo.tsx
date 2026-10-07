"use client";

import { useMe } from "@/components/app/session";
import { LogoMark } from "@/components/ui/logo";
import { cn } from "@/lib/cn";

/** The organization's uploaded logo, or the product mark when there is none. */
export function OrgLogo({ src, className }: { src: string | null | undefined; className?: string }) {
  if (!src) return <LogoMark className={className} />;
  return <img src={src} alt="" aria-hidden className={cn("size-7 shrink-0 rounded-[22%] object-contain", className)} data-testid="org-logo" />;
}

/** The signed-in organization's logo (assistant avatars, admin header). */
export function AppLogo({ className }: { className?: string }) {
  const { data } = useMe();
  return <OrgLogo src={data?.org.logoUrl} className={className} />;
}
