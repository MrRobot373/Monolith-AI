"use client";

import { Switch as RSwitch, Tooltip as RTooltip } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { initials } from "@/lib/format";

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("rounded-xl border border-border bg-surface", className)}>{children}</div>;
}

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";
const tones: Record<Tone, string> = {
  neutral: "bg-transparent text-fg-muted border-border",
  accent: "bg-surface-2 text-fg border-border-strong",
  success: "bg-success-soft text-success border-transparent",
  warning: "bg-warning-soft text-warning border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
};

export function Badge({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-md border px-1.5 text-[11px] whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Avatar({ name, image, className }: { name: string; image?: string | null; className?: string }) {
  return image ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={image} alt="" className={cn("size-7 rounded-full object-cover", className)} />
  ) : (
    <span
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[11px] font-semibold text-fg-muted",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <RSwitch.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-border bg-surface-3 transition-colors duration-200 data-[state=checked]:border-fg data-[state=checked]:bg-fg disabled:opacity-50"
    >
      <RSwitch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-fg shadow transition-transform duration-200 ease-[var(--ease-out-soft)] data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-bg" />
    </RSwitch.Root>
  );
}

export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "right" | "bottom" | "left" }) {
  return (
    <RTooltip.Root delayDuration={300}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side={side}
          sideOffset={6}
          className="z-50 animate-fade-in rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-fg shadow-soft"
        >
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      {icon && (
        <div className="mb-4 flex size-11 items-center justify-center rounded-xl border border-border bg-surface-2 text-fg-muted">
          {icon}
        </div>
      )}
      <h3 className="text-[15px] font-medium text-fg">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-sm text-fg-muted">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Meter({ value, className }: { value: number | null; className?: string }) {
  const v = value === null ? 0 : Math.min(1, Math.max(0, value));
  const tone = v >= 0.95 ? "bg-danger" : v >= 0.8 ? "bg-warning" : "bg-fg-muted";
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-full bg-surface-3", className)}>
      <div className={cn("h-full rounded-full transition-[width] duration-500 ease-out", tone)} style={{ width: `${v * 100}%` }} />
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-surface-2 px-1 font-mono text-[10px] text-fg-subtle">
      {children}
    </kbd>
  );
}
