"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { SidebarOpenButton } from "./sidebar-state";

/** The app sits in a rounded window on a darker canvas, like a native desktop app. */
export function AppFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="h-dvh bg-canvas md:p-2">
      <div
        className={cn(
          "flex h-full overflow-hidden bg-bg md:rounded-xl md:border md:border-border md:shadow-[0_0_0_1px_rgb(0_0_0/0.25)]",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Page top bar: title on the left, actions on the right. */
export function TopBar({
  icon,
  title,
  actions,
  leading,
}: {
  icon?: ReactNode;
  title: ReactNode;
  actions?: ReactNode;
  leading?: ReactNode;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
      <SidebarOpenButton />
      {leading}
      <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
        {icon && <span className="shrink-0 text-fg-subtle [&>svg]:size-4">{icon}</span>}
        <div className="min-w-0 truncate text-fg">{title}</div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}

export function TopBarButton({ children, className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-50 [&>svg]:size-3.5",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function Divider() {
  return <span className="mx-1 h-4 w-px bg-border" />;
}
