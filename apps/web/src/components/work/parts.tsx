"use client";

import { ArrowUp, Check, ChevronDown, CircleAlert, CircleCheck, CircleDot, CirclePause, CircleSlash, Clock, Loader2, Paperclip, Square, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { FileIcon } from "@/components/documents/use-documents";
import { Tooltip } from "@/components/ui/misc";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/overlay";
import { cn } from "@/lib/cn";
import type { AvailableModel } from "@/lib/types";
import { STATUS_LABEL, type TaskStatus } from "@/lib/work";

export function StatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const cls = cn("size-3.5 shrink-0", className);
  switch (status) {
    case "running":
      return <Loader2 className={cn(cls, "animate-spin text-accent-text")} />;
    case "queued":
      return <Clock className={cn(cls, "text-fg-subtle")} />;
    case "needs_approval":
      return <CirclePause className={cn(cls, "text-warning")} />;
    case "completed":
      return <CircleCheck className={cn(cls, "text-success")} />;
    case "failed":
      return <CircleAlert className={cn(cls, "text-danger")} />;
    case "cancelled":
      return <CircleSlash className={cn(cls, "text-fg-subtle")} />;
    default:
      return <CircleDot className={cls} />;
  }
}

export function StatusPill({ status }: { status: TaskStatus }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-[12px] whitespace-nowrap",
        status === "needs_approval" ? "border-warning/40 bg-warning-soft text-warning" : status === "failed" ? "border-danger/30 bg-danger-soft text-danger" : "border-border text-fg-muted",
      )}
      data-testid="task-status"
      data-status={status}
    >
      <StatusIcon status={status} className="size-3" />
      {STATUS_LABEL[status]}
    </span>
  );
}

const TABS = [
  { href: "/app/work", label: "Tasks", exact: true },
  { href: "/app/work/schedules", label: "Scheduled" },
  { href: "/app/work/skills", label: "Skills" },
  { href: "/app/work/connections", label: "Connections" },
];

/** Tasks · Scheduled · Skills · Connections, under the top bar of Work AI's list pages. */
export function WorkTabs() {
  const pathname = usePathname();
  return (
    <div className="flex h-10 shrink-0 items-end gap-5 border-b border-border px-4 sm:px-6">
      {TABS.map((t) => {
        const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "-mb-px border-b-2 pb-2 text-[13px] transition-colors",
              active ? "border-fg text-fg" : "border-transparent text-fg-subtle hover:text-fg-muted",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}

export interface StagedFile {
  key: string;
  file: File;
}

export interface WorkComposerHandle {
  focus: () => void;
}

/** Prompt box for tasks: text, optional files, model, and send / stop. */
export const WorkComposer = forwardRef<
  WorkComposerHandle,
  {
    value: string;
    onChange: (v: string) => void;
    onSubmit: () => void;
    placeholder: string;
    busy?: boolean;
    onStop?: () => void;
    sending?: boolean;
    files?: StagedFile[];
    onFiles?: (files: File[]) => void;
    onRemoveFile?: (key: string) => void;
    models?: AvailableModel[];
    model?: AvailableModel;
    onModelChange?: (m: AvailableModel) => void;
    size?: "home" | "thread";
    disabled?: boolean;
  }
>(function WorkComposer(p, ref) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => ta.current?.focus() }));
  useEffect(() => {
    const t = ta.current;
    if (!t) return;
    t.style.height = "0px";
    t.style.height = `${Math.min(t.scrollHeight, 260)}px`;
  }, [p.value]);
  const canSend = !!p.value.trim() && !p.sending && !p.disabled;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) p.onSubmit();
      }}
      className={cn("rounded-xl border border-border-strong bg-surface transition-colors focus-within:border-fg-subtle/70", p.disabled && "opacity-60")}
    >
      {p.files && p.files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-3">
          {p.files.map((f) => (
            <span key={f.key} className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-md border border-border bg-bg pr-1 pl-2 text-[12.5px] text-fg">
              <FileIcon name={f.file.name} className="size-3.5" />
              <span className="truncate">{f.file.name}</span>
              <button type="button" aria-label={`Remove ${f.file.name}`} onClick={() => p.onRemoveFile?.(f.key)} className="rounded p-0.5 text-fg-subtle hover:bg-surface-2 hover:text-fg">
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSend) p.onSubmit();
          }
        }}
        rows={p.size === "home" ? 3 : 1}
        placeholder={p.placeholder}
        disabled={p.disabled}
        className={cn(
          "block w-full resize-none bg-transparent px-4 text-[14px] leading-relaxed text-fg outline-none placeholder:text-fg-subtle",
          p.size === "home" ? "min-h-[84px] pt-4" : "pt-3.5",
        )}
        data-testid="work-input"
      />
      <div className="flex items-center gap-1 px-2 pt-1 pb-2">
        {p.onFiles && (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const list = [...(e.target.files ?? [])];
                if (list.length) p.onFiles!(list);
                e.target.value = "";
              }}
              data-testid="work-file-input"
            />
            <Tooltip content="Add files to the task folder">
              <button type="button" onClick={() => fileRef.current?.click()} aria-label="Add files" className="rounded-md p-1.5 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg">
                <Paperclip className="size-4" />
              </button>
            </Tooltip>
          </>
        )}
        <div className="flex-1" />
        {p.models && p.model && p.onModelChange && (
          <Menu>
            <MenuTrigger asChild>
              <button type="button" className="inline-flex h-7 max-w-52 items-center gap-1 rounded-md px-2 text-[12.5px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg">
                <span className="truncate">{p.model.displayName}</span>
                <ChevronDown className="size-3 shrink-0" />
              </button>
            </MenuTrigger>
            <MenuContent align="end" className="w-64">
              <MenuLabel>Model for this task</MenuLabel>
              {p.models.map((m) => (
                <MenuItem key={m.id} onSelect={() => p.onModelChange!(m)} shortcut={m.id === p.model!.id ? <Check className="size-3.5" /> : null}>
                  <span className="flex flex-col">
                    <span>{m.displayName}</span>
                    <span className="text-[11.5px] text-fg-subtle">
                      {m.id === "auto"
                        ? `Picks by the task: ${m.tiers?.map((t) => t.displayName).join(", ")}`
                        : `${m.providerName}${m.groups?.length ? ` · via ${m.groups.map((g) => g.name).join(", ")}` : ""}`}
                    </span>
                  </span>
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}
        {p.busy && p.onStop && (
          <Tooltip content="Stop the task">
            <button type="button" onClick={p.onStop} aria-label="Stop" className="flex size-8 items-center justify-center rounded-lg border border-border text-fg transition-colors hover:bg-surface-2" data-testid="work-stop">
              <Square className="size-3 fill-current" />
            </button>
          </Tooltip>
        )}
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send"
          className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-fg transition-opacity disabled:opacity-30"
          data-testid="work-send"
        >
          {p.sending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
        </button>
      </div>
    </form>
  );
});
