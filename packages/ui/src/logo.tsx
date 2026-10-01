import { cn } from "./cn";

/**
 * Aatmiq mark: a standing stone (the "self") with an inner light.
 * The inner dot uses the accent so it follows each organization's color.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-7", className)} fill="none" aria-hidden>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--surface-3)" stroke="var(--border-strong)" />
      <path d="M10 24 L16 7.5 L22 24" stroke="var(--fg)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="18.2" r="2.4" fill="var(--accent)" />
    </svg>
  );
}

export function Logo({ name = "Aatmiq", className }: { name?: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark />
      <span className="text-[17px] font-semibold tracking-tight text-fg">{name}</span>
    </span>
  );
}
