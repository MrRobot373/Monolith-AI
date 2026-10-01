"use client";

import { X } from "lucide-react";
import { Dialog as RDialog, DropdownMenu as RMenu } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "./cn";

/* ───────────── Dialog ───────────── */

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-fade-in" />
        <RDialog.Content
          className={cn(
            "fixed top-1/2 left-1/2 z-50 w-[calc(100vw-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-surface shadow-soft outline-none data-[state=open]:animate-rise",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-5">
            <div>
              <RDialog.Title className="text-[15px] font-medium text-fg">{title}</RDialog.Title>
              {description ? (
                <RDialog.Description className="mt-1 text-sm text-fg-muted">{description}</RDialog.Description>
              ) : (
                <RDialog.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</RDialog.Description>
              )}
            </div>
            <RDialog.Close className="-mt-1 -mr-1 rounded-md p-1 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg" aria-label="Close">
              <X className="size-4" />
            </RDialog.Close>
          </div>
          {children && <div className="px-5 pt-4 pb-1">{children}</div>}
          {footer && <div className="flex justify-end gap-2 px-5 pt-3 pb-5">{footer}</div>}
          {!footer && <div className="h-5" />}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/* ───────────── Dropdown menu ───────────── */

export const Menu = RMenu.Root;
export const MenuTrigger = RMenu.Trigger;

export function MenuContent({
  children,
  align = "start",
  side = "bottom",
  className,
}: {
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}) {
  return (
    <RMenu.Portal>
      <RMenu.Content
        align={align}
        side={side}
        sideOffset={6}
        className={cn(
          "z-50 min-w-48 animate-rise rounded-xl border border-border-strong bg-surface p-1 shadow-soft outline-none",
          className,
        )}
      >
        {children}
      </RMenu.Content>
    </RMenu.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  icon,
  danger,
  shortcut,
  disabled,
}: {
  children: ReactNode;
  onSelect?: () => void;
  icon?: ReactNode;
  danger?: boolean;
  shortcut?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <RMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex h-8 cursor-default items-center gap-2.5 rounded-lg px-2 text-[13px] outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2",
        danger ? "text-danger" : "text-fg",
      )}
    >
      {icon && <span className={cn("[&>svg]:size-4", danger ? "text-danger" : "text-fg-subtle")}>{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {shortcut && <span className="text-xs text-fg-subtle">{shortcut}</span>}
    </RMenu.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <RMenu.Label className="px-2 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-fg-subtle uppercase">{children}</RMenu.Label>;
}

export function MenuSeparator() {
  return <RMenu.Separator className="my-1 h-px bg-border" />;
}
