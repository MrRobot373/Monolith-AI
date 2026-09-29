"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowUpRight,
  BookmarkPlus,
  Check,
  ChevronRight,
  Eye,
  FolderInput,
  MoreHorizontal,
  Share2,
  Code2,
  Copy,
  FileText,
  Github,
  HardDrive,
  Lightbulb,
  Lock,
  Mail,
  MessageSquare,
  PenLine,
  RefreshCw,
  Slack,
  SquarePen,
  TriangleAlert,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Popover } from "radix-ui";
import { FileIcon, useDocuments } from "@/components/documents/use-documents";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { TopBar, TopBarButton } from "@/components/app/frame";
import { useSession } from "@/components/app/session";
import { useChats } from "@/components/app/sidebar";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/ui/logo";
import { Meter, Tooltip } from "@/components/ui/misc";
import { Skeleton } from "@/components/ui/spinner";
import { MoveToProjectDialog, ProjectIcon } from "@/components/projects/projects";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/overlay";
import { ApiError, get, patch, post, readSse, uploadDocument } from "@/lib/api";
import { cn } from "@/lib/cn";
import { greeting, timeAgo } from "@/lib/format";
import type { AvailableModel, ChatDetail, Citation, DocumentRow, QuotaStatus } from "@/lib/types";
import { SourcesRow, useSourceDialog } from "./citations";
import { Composer, type Attachment, type ComposerHandle } from "./composer";
import { Markdown } from "./markdown";
import { RequestTokensDialog } from "./request-tokens";

interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  error?: string | null;
  model?: string;
  attachments?: { id: string; name: string }[] | null;
  citations?: Citation[] | null;
}

const PERIOD_ADJ = { day: "daily", week: "weekly", month: "monthly" } as const;

/** Quick actions put a starter prompt into the composer for the user to finish. */
const QUICK_ACTIONS = [
  { icon: PenLine, label: "Draft an email", prompt: "Draft a polite email to " },
  { icon: FileText, label: "Summarize text", prompt: "Summarize the key points of the following:\n\n" },
  { icon: Code2, label: "Write code", prompt: "Write a function that " },
  { icon: Lightbulb, label: "Brainstorm ideas", prompt: "Give me 10 ideas for " },
];

const APPS = [
  { name: "Slack", icon: Slack, hue: 300, desc: "Read channels, post summaries and reply to threads on your behalf." },
  { name: "Google Drive", icon: HardDrive, hue: 145, desc: "Search, read and organize documents and spreadsheets." },
  { name: "Gmail", icon: Mail, hue: 25, desc: "Draft replies, triage your inbox and follow up automatically." },
  { name: "GitHub", icon: Github, hue: 260, desc: "Review pull requests, open issues and work in repositories." },
];

export function ChatView({
  chatId: initialId,
  onCreated,
  project: newChatProject,
  renderHome,
}: {
  chatId?: string;
  onCreated?: (id: string) => void;
  /** Start new chats inside this project. */
  project?: { id: string; name: string; color: string; canEdit: boolean };
  /** Replace the default home screen (used by project pages). */
  renderHome?: (parts: { composer: ReactNode; notices: ReactNode }) => ReactNode;
}) {
  const { me, workspaceId } = useSession();
  const router = useRouter();
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
  const composerRef = useRef<ComposerHandle>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [chatDocs, setChatDocs] = useState<{ id: string; name: string }[]>([]);
  const library = useDocuments(workspaceId);
  const searchParams = useSearchParams();
  const { openSource, sourceDialog } = useSourceDialog();

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
    queryFn: () => get<ChatDetail>(`/api/chats/${initialId}`),
    enabled: !!initialId,
    staleTime: Infinity,
  });
  const chats = useChats(workspaceId);
  const project = existing.data ? existing.data.project : newChatProject;
  const readOnly = !!existing.data?.readOnly;
  const [moving, setMoving] = useState(false);
  const [liveTitle, setLiveTitle] = useState<string | null>(null);
  const [shared, setShared] = useState(false);
  useEffect(() => setShared(!!existing.data?.sharedToProject), [existing.data?.sharedToProject]);

  const modelName = useCallback(
    (id: string | null | undefined) => models.data?.find((m) => m.id === id)?.displayName,
    [models.data],
  );

  useEffect(() => {
    if (!existing.data) return;
    setMessages(
      existing.data.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          id: m.id,
          role: m.role as UiMessage["role"],
          content: m.content,
          error: m.error,
          model: m.modelId ?? undefined,
          attachments: m.attachments,
          citations: m.citations,
        })),
    );
    setChatDocs(existing.data.documents ?? []);
    if (existing.data.modelId) setModelId(existing.data.modelId);
  }, [existing.data]);

  // Keep attachment chips in sync with processing status from the library.
  useEffect(() => {
    if (!library.data) return;
    setAttachments((list) =>
      list.map((a) => {
        const d = a.id ? library.data.find((x) => x.id === a.id) : undefined;
        return d && a.status !== "uploading" && d.status !== a.status ? { ...a, status: d.status } : a;
      }),
    );
  }, [library.data]);

  // "Ask about this" from the Documents page: /app/chat?doc=<id>
  const docParam = searchParams.get("doc");
  const attachedParam = useRef<string | null>(null);
  useEffect(() => {
    if (!docParam || attachedParam.current === docParam || !library.data) return;
    const d = library.data.find((x) => x.id === docParam);
    if (d) {
      attachedParam.current = docParam;
      setAttachments((l) => (l.some((a) => a.id === d.id) ? l : [...l, { key: d.id, id: d.id, name: d.name, status: d.status }]));
      composerRef.current?.focus();
    }
  }, [docParam, library.data]);

  const attachFiles = useCallback(
    async (files: File[]) => {
      for (const f of files) {
        const key = `${f.name}-${Date.now()}-${Math.random()}`;
        setAttachments((l) => [...l, { key, name: f.name, status: "uploading" }]);
        try {
          const doc = await uploadDocument(workspaceId, f);
          setAttachments((l) => l.map((a) => (a.key === key ? { ...a, id: doc.id, status: doc.status } : a)));
          qc.invalidateQueries({ queryKey: ["documents", workspaceId] });
        } catch (e) {
          toast.error(`${f.name}: ${(e as Error).message}`);
          setAttachments((l) => l.filter((a) => a.key !== key));
        }
      }
    },
    [qc, workspaceId],
  );
  const attachDocument = useCallback((d: DocumentRow) => {
    setAttachments((l) => (l.some((a) => a.id === d.id) ? l : [...l, { key: d.id, id: d.id, name: d.name, status: d.status }]));
  }, []);

  useEffect(() => {
    if (quota.data) setQuotaBlocked(!quota.data.result.allowed);
  }, [quota.data]);

  const model = models.data?.find((m) => m.id === modelId) ?? models.data?.find((m) => m.isDefault) ?? models.data?.[0];

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    composerRef.current?.focus();
  }, [initialId]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || streaming || !workspaceId) return;
      const sending = attachments.filter((a) => a.id && a.status !== "failed") as (Attachment & { id: string })[];
      setInput("");
      setAttachments([]);
      stickRef.current = true;

      let id = chatId;
      try {
        if (!id) {
          const created = await post<{ id: string }>("/api/chats", { workspaceId, modelId: model?.id, projectId: project?.id });
          id = created.id;
          setChatId(id);
          onCreated?.(id);
        }
      } catch (e) {
        toast.error((e as Error).message);
        setInput(content);
        return;
      }

      const newAttachments = sending.map((a) => ({ id: a.id, name: a.name }));
      const tempUser: UiMessage = { id: `u-${Date.now()}`, role: "user", content, attachments: newAttachments };
      if (newAttachments.length)
        setChatDocs((l) => [...l, ...newAttachments.filter((a) => !l.some((x) => x.id === a.id))]);
      const tempAsst: UiMessage = { id: `a-${Date.now()}`, role: "assistant", content: "", streaming: true, model: model?.id };
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
          body: JSON.stringify({ content, modelId: model?.id, documentIds: sending.length ? sending.map((a) => a.id) : undefined }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new ApiError(res.status, body.error ?? "Request failed", body.code, body.details);
        }
        for await (const ev of readSse(res)) {
          if (ev.event === "start") {
            if (ev.data.title) {
              setLiveTitle(ev.data.title);
              qc.invalidateQueries({ queryKey: ["chats", workspaceId] });
            }
            patchAsst((m) => ({ ...m, model: ev.data.model?.id ?? m.model, citations: ev.data.citations?.length ? ev.data.citations : null }));
          } else if (ev.event === "delta") patchAsst((m) => ({ ...m, content: m.content + ev.data.text }));
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
        if (project) {
          qc.invalidateQueries({ queryKey: ["project", project.id] });
          qc.invalidateQueries({ queryKey: ["projects", workspaceId] });
        }
      }
    },
    [attachments, chatId, model?.id, onCreated, project, qc, streaming, workspaceId],
  );

  const toggleShare = async () => {
    if (!chatId) return;
    try {
      await patch(`/api/chats/${chatId}`, { sharedToProject: !shared });
      setShared(!shared);
      toast(shared ? "Chat is private again" : `Shared with everyone in ${project?.name}`);
      if (project) qc.invalidateQueries({ queryKey: ["project", project.id] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const archive = async () => {
    if (!chatId) return;
    try {
      await patch(`/api/chats/${chatId}`, { archived: true });
      qc.invalidateQueries({ queryKey: ["chats", workspaceId] });
      qc.invalidateQueries({ queryKey: ["archived", workspaceId] });
      if (project) qc.invalidateQueries({ queryKey: ["project", project.id] });
      toast("Chat archived");
      router.push(project ? `/app/projects/${project.id}` : "/app/chat");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const saveAnswer = async (content: string) => {
    if (!project) return;
    try {
      const base = title === "New chat" ? "Saved answer" : title;
      await post(`/api/projects/${project.id}/sources/note`, {
        title: `${base.slice(0, 100)} (answer ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })})`,
        content,
        kind: "answer",
      });
      qc.invalidateQueries({ queryKey: ["project", project.id] });
      toast(`Saved to ${project.name} sources`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const regenerate = () => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) send(lastUser.content);
  };

  const isHome = !initialId && messages.length === 0;
  const firstName = me.user.name.split(" ")[0];
  const noModels = models.data && models.data.length === 0;
  const title = isHome
    ? "New chat"
    : (chats.data?.find((c) => c.id === chatId)?.title ?? liveTitle ?? existing.data?.title ?? "New chat");
  const newChatHref = project ? `/app/projects/${project.id}` : "/app/chat";
  const recent = (chats.data ?? []).slice(0, 4);

  const composer = (size: "home" | "thread") => (
    <Composer
      ref={composerRef}
      size={size}
      value={input}
      onChange={setInput}
      onSubmit={() => send(input)}
      onStop={() => abortRef.current?.abort()}
      streaming={streaming}
      disabled={quotaBlocked || !!noModels}
      placeholder={
        quotaBlocked
          ? "You've reached your token allowance"
          : size === "home"
            ? "Example: Summarize this contract and list every renewal date…"
            : "Reply to Aatmiq…"
      }
      models={models.data}
      model={model}
      onModelChange={(m) => setModelId(m.id)}
      attachments={attachments}
      onAttachFiles={attachFiles}
      onAttachDocument={attachDocument}
      onRemoveAttachment={(key) => setAttachments((l) => l.filter((a) => a.key !== key))}
      library={library.data}
    />
  );

  const notices = (
    <>
      {quotaBlocked && quota.data && <QuotaBanner quota={quota.data} onRequest={() => setRequestOpen(true)} />}
      {noModels && (
        <div className="mb-3 rounded-xl border border-border bg-surface px-4 py-3 text-[13px] text-fg-muted">
          No models are enabled in this workspace yet. Ask your admin to add one.
        </div>
      )}
    </>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar
        icon={project ? <ProjectIcon color={project.color} /> : isHome ? <SquarePen /> : <MessageSquare />}
        title={
          project ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <Link href={`/app/projects/${project.id}`} className="shrink-0 text-fg-muted transition-colors hover:text-fg">
                {project.name}
              </Link>
              <ChevronRight className="size-3.5 shrink-0 text-fg-subtle" />
              <span className={cn("truncate", isHome && "text-fg-muted")}>{title}</span>
            </span>
          ) : (
            <span className={cn(isHome && "text-fg-muted")}>{title}</span>
          )
        }
        actions={
          <>
            {!isHome && chatDocs.length > 0 && <ChatDocsButton docs={chatDocs} />}
            {project && !isHome && !readOnly && chatId && (
              <TopBarButton onClick={toggleShare} data-testid="share-to-project" className={cn(shared && "text-fg")}>
                <Share2 /> {shared ? "Shared to project" : "Share to project"}
              </TopBarButton>
            )}
            <Tooltip content="Conversations stay on your organization's servers">
              <span className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-fg-subtle">
                <Lock className="size-3.5" /> Private
              </span>
            </Tooltip>
            {!isHome && (
              <TopBarButton onClick={() => router.push(newChatHref)}>
                <SquarePen /> New
              </TopBarButton>
            )}
            {!isHome && !readOnly && chatId && (
              <Menu>
                <MenuTrigger asChild>
                  <TopBarButton aria-label="Chat options">
                    <MoreHorizontal />
                  </TopBarButton>
                </MenuTrigger>
                <MenuContent align="end" className="min-w-44">
                  <MenuItem icon={<FolderInput />} onSelect={() => setMoving(true)}>
                    {project ? "Move to another project" : "Move to project"}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem icon={<Archive />} onSelect={archive}>Archive</MenuItem>
                </MenuContent>
              </Menu>
            )}
          </>
        }
      />
      {me.org.promptLogging && (
        <div className="flex items-center justify-center gap-2 border-b border-border px-4 py-1.5 text-center text-xs text-warning">
          <TriangleAlert className="size-3.5 shrink-0" /> Your organization records chat conversations for compliance.
        </div>
      )}

      {isHome && renderHome ? (
        renderHome({ composer: composer("home"), notices })
      ) : isHome ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[760px] flex-col px-4 pt-[12vh] pb-10 sm:px-6">
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }} className="text-center">
              <h1 className="font-serif text-[38px] leading-tight tracking-[-0.02em] text-fg">
                {greeting()}, {firstName}
              </h1>
              <p className="mt-2 text-[13px] text-fg-subtle">I&apos;m {me.org.productName}, where should we start today?</p>
            </motion.div>
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08, duration: 0.45 }} className="mt-8">
              {notices}
              {composer("home")}
            </motion.div>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              {QUICK_ACTIONS.map((a, i) => (
                <motion.button
                  key={a.label}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15 + i * 0.04 }}
                  onClick={() => {
                    setInput(a.prompt);
                    composerRef.current?.focus();
                  }}
                  className="inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-bg px-3 text-[13px] text-fg-muted transition-colors hover:border-border-strong hover:bg-surface hover:text-fg"
                >
                  <a.icon className="size-3.5" />
                  {a.label}
                </motion.button>
              ))}
            </div>
          </div>

          <div className="mx-auto w-full max-w-5xl space-y-10 px-4 pb-12 sm:px-6">
            {recent.length > 0 && (
              <section>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-[13px] text-fg">
                    Previous chats <span className="text-fg-subtle">({chats.data?.length})</span>
                  </h2>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {recent.map((c) => (
                    <Link
                      key={c.id}
                      href={`/app/chat/${c.id}`}
                      className="group flex h-[88px] min-w-0 flex-col justify-between rounded-xl border border-border bg-surface p-3.5 transition-colors hover:border-border-strong"
                    >
                      <MessageSquare className="size-3.5 text-fg-subtle" />
                      <div>
                        <div className="truncate text-[13px] text-fg">{c.title}</div>
                        <div className="mt-0.5 text-[11.5px] text-fg-subtle">{timeAgo(c.updatedAt)}</div>
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            )}
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[13px] text-fg">Connect your tools</h2>
                <span className="text-[12px] text-fg-subtle">Arrives with Work AI</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {APPS.map((a) => (
                  <div key={a.name} className="min-w-0 rounded-xl border border-border bg-surface p-3.5">
                    <div className="flex items-center gap-2.5">
                      <span
                        className="flex size-6 items-center justify-center rounded-md text-white"
                        style={{ background: `oklch(0.6 0.15 ${a.hue})` }}
                      >
                        <a.icon className="size-3.5" />
                      </span>
                      <span className="flex-1 text-[13px] text-fg">{a.name}</span>
                      <span className="rounded border border-border px-1.5 py-px text-[10.5px] text-fg-subtle">Soon</span>
                    </div>
                    <p className="mt-2.5 line-clamp-2 text-[12px] leading-relaxed text-fg-subtle">{a.desc}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      ) : (
        <>
          <div
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {existing.isLoading ? (
              <div className="mx-auto max-w-[760px] space-y-5 px-4 pt-10 sm:px-6">
                <Skeleton className="h-14 w-full rounded-xl" />
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-5/6" />
                <Skeleton className="h-3.5 w-3/5" />
              </div>
            ) : (
              <div className="mx-auto max-w-[760px] px-4 pt-8 pb-10 sm:px-6">
                <AnimatePresence initial={false}>
                  {messages.map((m, i) => (
                    <MessageBlock
                      key={m.id}
                      message={m}
                      modelLabel={modelName(m.model) ?? model?.displayName ?? "Aatmiq"}
                      isLast={i === messages.length - 1}
                      onRegenerate={!streaming && !readOnly ? regenerate : undefined}
                      onCite={openSource}
                      onSave={project?.canEdit && !readOnly ? saveAnswer : undefined}
                    />
                  ))}
                </AnimatePresence>
              </div>
            )}
          </div>
          <div className="px-4 pb-3 sm:px-6">
            <div className="mx-auto max-w-[760px]">
              {readOnly ? (
                <div className="mb-1 flex items-center gap-2.5 rounded-xl border border-border bg-surface px-4 py-3 text-[13px] text-fg-muted" data-testid="read-only">
                  <Eye className="size-4 shrink-0 text-fg-subtle" />
                  <span className="min-w-0 flex-1">
                    Shared to this project by <span className="text-fg">{existing.data?.authorName}</span>. You can read it; replies stay with its author.
                  </span>
                  <Button variant="outline" size="sm" onClick={() => router.push(newChatHref)}>
                    Start your own chat
                  </Button>
                </div>
              ) : (
                <>
                  {notices}
                  {composer("thread")}
                  <FooterHint quota={quota.data} blocked={quotaBlocked} orgName={me.org.name} onRequest={() => setRequestOpen(true)} />
                </>
              )}
            </div>
          </div>
        </>
      )}
      <MoveToProjectDialog
        chat={moving && chatId ? { id: chatId, title, projectId: project?.id ?? null } : null}
        onOpenChange={(o) => {
          if (o) return;
          setMoving(false);
          qc.invalidateQueries({ queryKey: ["chat", chatId] });
        }}
      />
      <RequestTokensDialog open={requestOpen} onOpenChange={setRequestOpen} workspaceId={workspaceId} />
      {sourceDialog}
    </div>
  );
}

function MessageBlock({
  message: m,
  modelLabel,
  isLast,
  onRegenerate,
  onCite,
  onSave,
}: {
  message: UiMessage;
  modelLabel: string;
  isLast: boolean;
  onRegenerate?: () => void;
  onCite: (c: Citation) => void;
  onSave?: (content: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  if (m.role === "user") {
    return (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }} className="mb-6">
        <div className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-[14px] leading-relaxed whitespace-pre-wrap text-fg">
          {m.attachments && m.attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5 whitespace-normal">
              {m.attachments.map((a) => (
                <span key={a.id} className="inline-flex h-6 max-w-60 items-center gap-1.5 rounded-md border border-border bg-bg px-2 text-[12px]">
                  <FileIcon name={a.name} className="size-3.5" />
                  <span className="truncate">{a.name}</span>
                </span>
              ))}
            </div>
          )}
          {m.content}
        </div>
      </motion.div>
    );
  }
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }} className="group mb-8">
      <div className="mb-2 flex items-center gap-2 text-[12.5px] text-fg-subtle">
        <LogoMark className="size-4" />
        <span>{modelLabel}</span>
        {m.streaming && (
          <span className="bg-[linear-gradient(90deg,var(--fg-subtle)_0%,var(--fg)_50%,var(--fg-subtle)_100%)] bg-[length:200%_100%] bg-clip-text text-transparent animate-shimmer">
            {m.content ? "Writing…" : "Thinking…"}
          </span>
        )}
      </div>
      <div className="pl-6">
        {m.content ? <Markdown content={m.content} citations={m.citations} onCite={onCite} /> : null}
        {m.streaming && m.content && <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-[2px] animate-caret bg-fg" />}
        {!m.streaming && m.citations && m.citations.length > 0 && <SourcesRow citations={m.citations} onOpen={onCite} />}
        {m.error && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{m.error}</span>
          </div>
        )}
        {!m.streaming && (
          <div className={cn("mt-2 -ml-1.5 flex gap-0.5 transition-opacity", isLast ? "opacity-100" : "opacity-0 group-hover:opacity-100")}>
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
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              </Button>
            </Tooltip>
            {onSave && m.content && !m.error && (
              <Tooltip content="Save to project sources">
                <Button variant="ghost" size="icon-sm" aria-label="Save to project" onClick={() => onSave(m.content)}>
                  <BookmarkPlus className="size-3.5" />
                </Button>
              </Tooltip>
            )}
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

function QuotaBanner({ quota, onRequest }: { quota: QuotaStatus; onRequest: () => void }) {
  const who = quota.result.blockedBy === "workspace" ? "This workspace has" : "You've";
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-4 py-3">
      <TriangleAlert className="size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-fg">{who} used this {quota.period}&apos;s token allowance</div>
        <div className="text-xs text-fg-subtle">
          Resets {new Date(quota.resetsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}. You can ask your admin for more now.
        </div>
      </div>
      <Button variant="primary" size="sm" onClick={onRequest}>
        Request more
      </Button>
    </motion.div>
  );
}

function FooterHint({ quota, blocked, orgName, onRequest }: { quota?: QuotaStatus; blocked: boolean; orgName: string; onRequest: () => void }) {
  const f = quota?.result.usedFraction ?? null;
  return (
    <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11.5px] text-fg-subtle">
      <span className="whitespace-nowrap">Private to {orgName || "your organization"}. AI can make mistakes.</span>
      {quota && f !== null && f >= 0.5 && !blocked && (
        <button onClick={onRequest} className="inline-flex items-center gap-2 whitespace-nowrap transition-colors hover:text-fg">
          <Meter value={f} className="w-12" />
          {Math.round(f * 100)}% of your {PERIOD_ADJ[quota.period]} allowance
          <ArrowUpRight className="size-3" />
        </button>
      )}
    </div>
  );
}

function ChatDocsButton({ docs }: { docs: { id: string; name: string }[] }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg">
          <FileText className="size-3.5" /> {docs.length} {docs.length === 1 ? "document" : "documents"}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="z-50 w-72 animate-rise rounded-xl border border-border-strong bg-surface p-1 shadow-soft outline-none">
          <div className="px-2 pt-1.5 pb-1 text-[11.5px] text-fg-subtle">Answers in this chat can use</div>
          {docs.map((d) => (
            <a
              key={d.id}
              href={`/api/documents/${d.id}/file`}
              className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] hover:bg-surface-2"
            >
              <FileIcon name={d.name} />
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
            </a>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
