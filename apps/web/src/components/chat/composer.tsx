"use client";

import { ArrowUp, AtSign, Check, ChevronDown, Loader2, Mic, Plus, Search, Sparkles, Square, X } from "lucide-react";
import { Popover } from "radix-ui";
import { ACCEPT, FileIcon } from "@/components/documents/use-documents";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Tooltip } from "@/components/ui/misc";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/overlay";
import { cn } from "@/lib/cn";
import { formatTokens } from "@/lib/format";
import { TIER_NAMES } from "@/lib/format";
import type { AvailableModel, DocumentRow } from "@/lib/types";

export interface Attachment {
  key: string;
  id?: string;
  name: string;
  status: "uploading" | "processing" | "ready" | "failed";
}

export interface ComposerHandle {
  focus: () => void;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  placeholder: string;
  models?: AvailableModel[];
  model?: AvailableModel;
  onModelChange: (m: AvailableModel) => void;
  size?: "home" | "thread";
  attachments: Attachment[];
  onAttachFiles: (files: File[]) => void;
  onAttachDocument: (doc: DocumentRow) => void;
  onRemoveAttachment: (key: string) => void;
  library?: DocumentRow[];
}

/** Bordered prompt box: text on top, tools and send on the bottom row. */
export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  {
    value,
    onChange,
    onSubmit,
    onStop,
    streaming,
    disabled,
    placeholder,
    models,
    model,
    onModelChange,
    size = "thread",
    attachments,
    onAttachFiles,
    onAttachDocument,
    onRemoveAttachment,
    library,
  },
  ref,
) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => ta.current?.focus() }));

  useEffect(() => {
    const t = ta.current;
    if (!t) return;
    t.style.height = "0px";
    t.style.height = `${Math.min(t.scrollHeight, 260)}px`;
  }, [value]);

  const uploading = attachments.some((a) => a.status === "uploading");
  const canSend = !!value.trim() && !disabled && !uploading;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onSubmit();
      }}
      className={cn(
        "rounded-xl border border-border-strong bg-surface transition-[border-color,box-shadow] duration-200",
        "focus-within:border-fg-subtle/70",
        disabled && "opacity-60",
      )}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-3 pt-3">
          {attachments.map((a) => (
            <span
              key={a.key}
              className={cn(
                "inline-flex h-7 max-w-64 items-center gap-1.5 rounded-md border bg-bg pr-1 pl-2 text-[12.5px]",
                a.status === "failed" ? "border-danger/40 text-danger" : "border-border text-fg",
              )}
            >
              {a.status === "uploading" || a.status === "processing" ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-fg-subtle" />
              ) : (
                <FileIcon name={a.name} className="size-3.5" />
              )}
              <span className="truncate">{a.name}</span>
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() => onRemoveAttachment(a.key)}
                className="rounded p-0.5 text-fg-subtle hover:bg-surface-2 hover:text-fg"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        data-testid="composer-upload"
        onChange={(e) => {
          if (e.target.files?.length) onAttachFiles(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
      <textarea
        ref={ta}
        rows={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSend && !streaming) onSubmit();
          }
        }}
        placeholder={placeholder}
        className={cn(
          "block w-full resize-none bg-transparent px-4 pt-3.5 text-[14px] leading-relaxed text-fg outline-none placeholder:text-fg-subtle",
          size === "home" ? "min-h-[64px]" : "min-h-[44px]",
        )}
      />
      <div className="flex items-center gap-0.5 px-2 pt-1 pb-2">
        <ToolButton label="Upload files" onClick={() => fileRef.current?.click()} disabled={disabled}>
          <Plus />
        </ToolButton>
        <DocumentPicker
          library={library}
          attachedIds={attachments.map((a) => a.id).filter(Boolean) as string[]}
          onPick={onAttachDocument}
          disabled={disabled}
        />
        <span className="mx-1.5 h-4 w-px bg-border max-sm:hidden" />
        <span className="max-sm:hidden">
          <ToolButton label="Skills · coming with Work AI" disabled wide>
            <Sparkles /> <span>Skills</span>
          </ToolButton>
        </span>
        <ModelPicker models={models} value={model} onChange={onModelChange} />
        <span className="flex-1" />
        <span className="max-sm:hidden">
          <ToolButton label="Voice input · coming soon" disabled>
            <Mic />
          </ToolButton>
        </span>
        {streaming ? (
          <Tooltip content="Stop generating">
            <button
              type="button"
              aria-label="Stop"
              onClick={onStop}
              className="ml-1 flex size-8 items-center justify-center rounded-lg bg-primary text-primary-fg transition-opacity hover:opacity-90"
            >
              <Square className="size-3 fill-current" />
            </button>
          </Tooltip>
        ) : (
          <button
            type="submit"
            aria-label="Send"
            disabled={!canSend}
            className="ml-1 flex size-8 items-center justify-center rounded-lg bg-primary text-primary-fg transition-[opacity,transform] hover:opacity-90 active:scale-95 disabled:bg-surface-3 disabled:text-fg-subtle"
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </div>
    </form>
  );
});

function ToolButton({
  children,
  label,
  disabled,
  wide,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  disabled?: boolean;
  wide?: boolean;
  onClick?: () => void;
}) {
  return (
    <Tooltip content={label}>
      <span>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            "flex h-7 items-center justify-center gap-1.5 rounded-md text-[13px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:text-fg-subtle [&_svg]:size-4",
            wide ? "px-2" : "w-7",
          )}
        >
          {children}
        </button>
      </span>
    </Tooltip>
  );
}

function ModelDot({ name }: { name: string }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hue = [190, 260, 330, 20, 140, 45][h % 6];
  return <span className="size-3 rounded-full ring-2 ring-surface" style={{ background: `oklch(0.72 0.14 ${hue})` }} />;
}

function ModelPicker({ models, value, onChange }: { models?: AvailableModel[]; value?: AvailableModel; onChange: (m: AvailableModel) => void }) {
  if (!models || models.length === 0) return <span className="px-2 text-[13px] text-fg-subtle">No model</span>;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="flex h-7 items-center gap-2 rounded-md px-2 text-[13px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <span className="flex -space-x-1">
            {value?.id === "auto" ? (
              <Sparkles className="size-3.5 text-accent" />
            ) : (
              models.slice(0, 3).map((m) => <ModelDot key={m.id} name={m.displayName} />)
            )}
          </span>
          <span className="max-w-40 truncate">{value?.displayName}</span>
          <ChevronDown className="size-3.5 text-fg-subtle" />
        </button>
      </MenuTrigger>
      <MenuContent side="top" className="w-72">
        <MenuLabel>Models in this workspace</MenuLabel>
        {models.map((m) =>
          m.id === "auto" ? (
            <MenuItem
              key={m.id}
              onSelect={() => onChange(m)}
              icon={<Sparkles className="size-3.5 text-accent" />}
              shortcut={m.id === value?.id ? <Check className="size-3.5" /> : null}
            >
              <span className="block truncate">Auto</span>
              <span className="block truncate text-[11px] text-fg-subtle" title={m.tiers?.map((t) => `${TIER_NAMES[t.tier]}: ${t.displayName}`).join("\n")}>
                Picks the model for each message: {m.tiers?.map((t) => `${TIER_NAMES[t.tier].toLowerCase()} ${t.displayName}`).join(", ")}
                {m.isDefault ? " · default" : ""}
              </span>
            </MenuItem>
          ) : (
            <MenuItem
              key={m.id}
              onSelect={() => onChange(m)}
              icon={<ModelDot name={m.displayName} />}
              shortcut={m.id === value?.id ? <Check className="size-3.5" /> : null}
            >
              <span className="block truncate">{m.displayName}</span>
              <span className="block truncate text-[11px] text-fg-subtle">
                {m.providerName}
                {m.contextLength ? ` · ${formatTokens(m.contextLength)} context` : ""}
                {m.isDefault ? " · default" : ""}
                {m.groups?.length ? ` · via ${m.groups.map((g) => g.name).join(", ")}` : ""}
              </span>
            </MenuItem>
          ),
        )}
      </MenuContent>
    </Menu>
  );
}

/** "@" picker: attach documents from the workspace library. */
function DocumentPicker({
  library,
  attachedIds,
  onPick,
  disabled,
}: {
  library?: DocumentRow[];
  attachedIds: string[];
  onPick: (d: DocumentRow) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const docs = (library ?? []).filter((d) => d.status === "ready" && d.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip content="Attach a document from your library">
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-label="Attach a document"
            disabled={disabled}
            className="flex size-7 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:text-fg-subtle"
          >
            <AtSign className="size-4" />
          </button>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          className="z-50 w-80 animate-rise rounded-xl border border-border-strong bg-surface p-1 shadow-soft outline-none"
        >
          <label className="flex h-8 items-center gap-2 border-b border-border px-2">
            <Search className="size-3.5 text-fg-subtle" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search documents"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-subtle"
            />
          </label>
          <div className="max-h-64 overflow-y-auto py-1">
            {docs.length === 0 && (
              <p className="px-3 py-6 text-center text-[12.5px] text-fg-subtle">
                {(library ?? []).length === 0 ? "No documents yet. Use + to upload one." : "No documents match."}
              </p>
            )}
            {docs.map((d) => {
              const attached = attachedIds.includes(d.id);
              return (
                <button
                  key={d.id}
                  type="button"
                  disabled={attached}
                  onClick={() => {
                    onPick(d);
                    setOpen(false);
                    setQ("");
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-surface-2 disabled:opacity-50"
                >
                  <FileIcon name={d.name} />
                  <span className="min-w-0 flex-1 truncate">{d.name}</span>
                  {attached ? <Check className="size-3.5 text-fg-subtle" /> : d.scope === "workspace" && <span className="text-[11px] text-fg-subtle">Shared</span>}
                </button>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
