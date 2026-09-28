"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  Cpu,
  FileText,
  Lightbulb,
  PenLine,
  RefreshCw,
  ShieldCheck,
  Square,
  TriangleAlert,
  Code2,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSession } from "@/components/app/session";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/ui/logo";
import { Meter, Tooltip } from "@/components/ui/misc";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/overlay";
import { Skeleton } from "@/components/ui/spinner";
import { ApiError, get, post, readSse } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatTokens, greeting } from "@/lib/format";
import type { AvailableModel, ChatMessageRow, QuotaStatus } from "@/lib/types";
import { Markdown } from "./markdown";
import { RequestTokensDialog } from "./request-tokens";

interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  error?: string | null;
}

const PERIOD_ADJ = { day: "daily", week: "weekly", month: "monthly" } as const;

const SUGGESTIONS = [
  { icon: PenLine, text: "Draft a polite follow-up email to a client who hasn't paid an invoice" },
  { icon: Lightbulb, text: "Explain our options for reducing cloud costs, as a short list" },
  { icon: Code2, text: "Write a Python script that merges CSV files in a folder" },
  { icon: FileText, text: "Summarize the key points of a contract I'll paste in" },
];

export function ChatView({ chatId: initialId, onCreated }: { chatId?: string; onCreated?: (id: string) => void }) {
  const { me, workspaceId } = useSession();
  const qc = useQueryClient();
  const [chatId, setChatId] = useState<string | undefined>(initialId);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [modelId, setModelId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [quotaBlocked, setQuotaBlocked] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const models = useQuery({
    queryKey: ["models", workspaceId, "chat"],
    queryFn: () => get<AvailableModel[]>(`/api/workspaces/${workspaceId}/models?section=chat`),
    enabled: !!workspaceId,
  });
  const quota = useQuery({
    queryKey: ["quota", workspaceId],
    queryFn: () => get<QuotaStatus>(`/api/workspaces/${workspaceId}/quota`),
    enabled: !!workspaceId,
  });
  const existing = useQuery({
    queryKey: ["chat", initialId],
    queryFn: () => get<{ id: string; modelId: string | null; title: string; messages: ChatMessageRow[] }>(`/api/chats/${initialId}`),
    enabled: !!initialId,
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!existing.data) return;
    setMessages(
      existing.data.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ id: m.id, role: m.role as UiMessage["role"], content: m.content, error: m.error })),
    );
    if (existing.data.modelId) setModelId(existing.data.modelId);
  }, [existing.data]);

  useEffect(() => {
    if (quota.data) setQuotaBlocked(!quota.data.result.allowed);
  }, [quota.data]);

  const model = models.data?.find((m) => m.id === modelId) ?? models.data?.find((m) => m.isDefault) ?? models.data?.[0];

  // Auto-scroll while streaming, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [initialId]);

  const autosize = () => {
    const t = textareaRef.current;
    if (!t) return;
    t.style.height = "0px";
    t.style.height = `${Math.min(t.scrollHeight, 240)}px`;
  };
  useEffect(autosize, [input]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || streaming || !workspaceId) return;
      setInput("");
      stickRef.current = true;

      let id = chatId;
      try {
        if (!id) {
          const created = await post<{ id: string }>("/api/chats", { workspaceId, modelId: model?.id });
          id = created.id;
          setChatId(id);
          onCreated?.(id);
        }
      } catch (e) {
        toast.error((e as Error).message);
        setInput(content);
        return;
      }

      const tempUser: UiMessage = { id: `u-${Date.now()}`, role: "user", content };
      const tempAsst: UiMessage = { id: `a-${Date.now()}`, role: "assistant", content: "", streaming: true };
      setMessages((m) => [...m, tempUser, tempAsst]);
      setStreaming(true);
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const patchAsst = (fn: (m: UiMessage) => UiMessage) =>
        setMessages((all) => all.map((m) => (m.id === tempAsst.id ? fn(m) : m)));

      try {
        const res = await fetch(`/api/chats/${id}/messages`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content, modelId: model?.id }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new ApiError(res.status, body.error ?? "Request failed", body.code, body.details);
        }
        for await (const ev of readSse(res)) {
          if (ev.event === "start" && ev.data.title) qc.invalidateQueries({ queryKey: ["chats", workspaceId] });
          else if (ev.event === "delta") patchAsst((m) => ({ ...m, content: m.content + ev.data.text }));
          else if (ev.event === "done") {
            patchAsst((m) => ({ ...m, id: ev.data.messageId, streaming: false }));
            if (ev.data.quota) qc.setQueryData(["quota", workspaceId], ev.data.quota);
          } else if (ev.event === "error") patchAsst((m) => ({ ...m, streaming: false, error: ev.data.message }));
        }
      } catch (e) {
        if (ctrl.signal.aborted) {
          patchAsst((m) => ({ ...m, streaming: false }));
        } else if (e instanceof ApiError && e.code === "quota_exceeded") {
          setMessages((all) => all.filter((m) => m.id !== tempAsst.id && m.id !== tempUser.id));
          setInput(content);
          setQuotaBlocked(true);
          if (e.details) qc.setQueryData(["quota", workspaceId], e.details);
        } else {
          patchAsst((m) => ({ ...m, streaming: false, error: (e as Error).message }));
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
        qc.invalidateQueries({ queryKey: ["chats", workspaceId] });
        qc.invalidateQueries({ queryKey: ["quota", workspaceId] });
      }
    },
    [chatId, model?.id, onCreated, qc, streaming, workspaceId],
  );

  const regenerate = () => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) send(lastUser.content);
  };

  const empty = messages.length === 0 && !existing.isLoading;
  const firstName = me.user.name.split(" ")[0];
  const noModels = models.data && models.data.length === 0;

  return (
    <div className="flex h-full flex-col">
      {me.org.promptLogging && (
        <div className="flex items-center justify-center gap-2 border-b border-border bg-warning-soft px-4 py-1.5 text-center text-xs text-warning">
          <TriangleAlert className="size-3.5 shrink-0" /> Your organization records chat conversations for compliance.
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {existing.isLoading ? (
          <div className="mx-auto max-w-3xl space-y-6 px-4 pt-16 sm:px-6">
            <Skeleton className="ml-auto h-10 w-2/3 rounded-2xl" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        ) : empty ? (
          <div className="flex h-full flex-col items-center justify-center px-4 pb-10">
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }} className="text-center">
              <LogoMark className="mx-auto mb-5 size-10" />
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                {greeting()}, {firstName}
              </h1>
              <p className="mt-2 text-fg-muted">How can I help today?</p>
            </motion.div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl px-4 pt-8 pb-10 sm:px-6">
            <AnimatePresence initial={false}>
              {messages.map((m, i) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  isLast={i === messages.length - 1}
                  onRegenerate={!streaming ? regenerate : undefined}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="px-4 pb-4 sm:px-6">
        <div className="mx-auto max-w-3xl">
          {quotaBlocked && quota.data && (
            <QuotaBanner quota={quota.data} onRequest={() => setRequestOpen(true)} />
          )}
          {noModels && (
            <div className="mb-3 flex items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-fg-muted">
              <Cpu className="size-4 shrink-0" /> No models are enabled in this workspace yet. Ask your admin to add one.
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
            className={cn(
              "rounded-2xl border border-border bg-surface shadow-soft transition-[border-color,box-shadow] duration-200 focus-within:border-border-strong focus-within:shadow-[0_0_0_4px_var(--color-accent-soft)]",
              quotaBlocked && "opacity-60",
            )}
          >
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              disabled={quotaBlocked || noModels}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder={quotaBlocked ? "You've reached your token allowance" : "Message privately…"}
              className="block max-h-60 min-h-[52px] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed outline-none placeholder:text-fg-subtle"
            />
            <div className="flex items-center gap-2 px-2.5 pt-1 pb-2.5">
              <ModelPicker models={models.data} value={model} onChange={(m) => setModelId(m.id)} />
              <span className="flex-1" />
              {streaming ? (
                <Tooltip content="Stop generating">
                  <Button type="button" variant="secondary" size="icon" onClick={() => abortRef.current?.abort()} aria-label="Stop" className="rounded-xl">
                    <Square className="size-3.5 fill-current" />
                  </Button>
                </Tooltip>
              ) : (
                <Button type="submit" variant="primary" size="icon" disabled={!input.trim() || quotaBlocked || noModels} aria-label="Send" className="rounded-xl">
                  <ArrowUp className="size-4" />
                </Button>
              )}
            </div>
          </form>
          {empty && !quotaBlocked && (
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((s, i) => (
                <motion.button
                  key={s.text}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1 + i * 0.05, duration: 0.3 }}
                  onClick={() => send(s.text)}
                  className="flex items-start gap-3 rounded-xl border border-border bg-surface/50 px-3.5 py-3 text-left text-[13px] leading-snug text-fg-muted transition-colors hover:border-border-strong hover:bg-surface hover:text-fg"
                >
                  <s.icon className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
                  {s.text}
                </motion.button>
              ))}
            </div>
          )}
          <div className="mt-2.5 flex items-center justify-center gap-3 text-[11.5px] text-fg-subtle">
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="size-3" /> Private to {me.org.name || "your organization"}
            </span>
            {quota.data && quota.data.result.usedFraction !== null && !quotaBlocked && (
              <UsageHint quota={quota.data} onRequest={() => setRequestOpen(true)} />
            )}
          </div>
        </div>
      </div>
      <RequestTokensDialog open={requestOpen} onOpenChange={setRequestOpen} workspaceId={workspaceId} />
    </div>
  );
}

function MessageBubble({ message: m, isLast, onRegenerate }: { message: UiMessage; isLast: boolean; onRegenerate?: () => void }) {
  const [copied, setCopied] = useState(false);
  if (m.role === "user") {
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }} className="mb-8 flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-surface-2 px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">{m.content}</div>
      </motion.div>
    );
  }
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }} className="group mb-8 flex gap-4">
      <LogoMark className={cn("mt-0.5 size-7 shrink-0", m.streaming && "animate-pulse")} />
      <div className="min-w-0 flex-1 pt-0.5">
        {m.content ? (
          <Markdown content={m.content} />
        ) : m.streaming ? (
          <div className="flex h-7 items-center gap-1">
            {[0, 1, 2].map((i) => (
              <span key={i} className="size-1.5 animate-bounce rounded-full bg-fg-subtle" style={{ animationDelay: `${i * 120}ms` }} />
            ))}
          </div>
        ) : null}
        {m.streaming && m.content && <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-[2px] animate-caret bg-accent" />}
        {m.error && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{m.error}</span>
          </div>
        )}
        {!m.streaming && (
          <div className={cn("mt-2 flex gap-0.5 transition-opacity", isLast ? "opacity-100" : "opacity-0 group-hover:opacity-100")}>
            <Tooltip content={copied ? "Copied" : "Copy"}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Copy"
                onClick={() => {
                  navigator.clipboard.writeText(m.content);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
              </Button>
            </Tooltip>
            {isLast && onRegenerate && (
              <Tooltip content="Regenerate">
                <Button variant="ghost" size="icon-sm" aria-label="Regenerate" onClick={onRegenerate}>
                  <RefreshCw className="size-3.5" />
                </Button>
              </Tooltip>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function ModelPicker({ models, value, onChange }: { models?: AvailableModel[]; value?: AvailableModel; onChange: (m: AvailableModel) => void }) {
  if (!models || models.length === 0) return <span className="px-2 text-xs text-fg-subtle">No model</span>;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg">
          <Cpu className="size-3.5" />
          <span className="max-w-40 truncate">{value?.displayName}</span>
          <ChevronDown className="size-3.5 text-fg-subtle" />
        </button>
      </MenuTrigger>
      <MenuContent side="top" className="w-72">
        <MenuLabel>Models available in this workspace</MenuLabel>
        {models.map((m) => (
          <MenuItem key={m.id} onSelect={() => onChange(m)} shortcut={m.id === value?.id ? <Check className="size-3.5 text-accent" /> : null}>
            <span className="block truncate">{m.displayName}</span>
            <span className="block truncate text-[11px] text-fg-subtle">
              {m.providerName}
              {m.contextLength ? ` · ${formatTokens(m.contextLength)} context` : ""}
            </span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function QuotaBanner({ quota, onRequest }: { quota: QuotaStatus; onRequest: () => void }) {
  const who = quota.result.blockedBy === "workspace" ? "This workspace has" : "You've";
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
      <div className="flex size-8 items-center justify-center rounded-lg bg-warning-soft text-warning">
        <TriangleAlert className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{who} used this {quota.period}&apos;s token allowance</div>
        <div className="text-xs text-fg-muted">Resets {new Date(quota.resetsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}. You can ask your admin for more now.</div>
      </div>
      <Button variant="primary" size="sm" onClick={onRequest}>Request more</Button>
    </motion.div>
  );
}

function UsageHint({ quota, onRequest }: { quota: QuotaStatus; onRequest: () => void }) {
  const f = quota.result.usedFraction ?? 0;
  if (f < 0.5) return null;
  return (
    <button onClick={onRequest} className="inline-flex items-center gap-2 transition-colors hover:text-fg">
      <Meter value={f} className="w-14" />
      {Math.round(f * 100)}% of your {PERIOD_ADJ[quota.period]} allowance
    </button>
  );
}
