"use client";

import { ArrowUp, AtSign, Check, ChevronDown, Mic, Plus, Sparkles, Square } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Tooltip } from "@/components/ui/misc";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/overlay";
import { cn } from "@/lib/cn";
import { formatTokens } from "@/lib/format";
import type { AvailableModel } from "@/lib/types";

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
}

/** Bordered prompt box: text on top, tools and send on the bottom row. */
export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { value, onChange, onSubmit, onStop, streaming, disabled, placeholder, models, model, onModelChange, size = "thread" },
  ref,
) {
  const ta = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => ta.current?.focus() }));

  useEffect(() => {
    const t = ta.current;
    if (!t) return;
    t.style.height = "0px";
    t.style.height = `${Math.min(t.scrollHeight, 260)}px`;
  }, [value]);

  const canSend = !!value.trim() && !disabled;

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
        <ToolButton label="Attach files · coming soon" disabled>
          <Plus />
        </ToolButton>
        <ToolButton label="Mention a document · coming soon" disabled>
          <AtSign />
        </ToolButton>
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
}: {
  children: React.ReactNode;
  label: string;
  disabled?: boolean;
  wide?: boolean;
}) {
  return (
    <Tooltip content={label}>
      <span>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
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
            {models.slice(0, 3).map((m) => (
              <ModelDot key={m.id} name={m.displayName} />
            ))}
          </span>
          <span className="max-w-40 truncate">{value?.displayName}</span>
          <ChevronDown className="size-3.5 text-fg-subtle" />
        </button>
      </MenuTrigger>
      <MenuContent side="top" className="w-72">
        <MenuLabel>Models in this workspace</MenuLabel>
        {models.map((m) => (
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
            </span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
