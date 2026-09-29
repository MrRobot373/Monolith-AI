"use client";

import { Printer } from "lucide-react";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Markdown } from "@/components/chat/markdown";
import { get } from "@/lib/api";
import { pathTo } from "@/lib/branches";
import type { ChatDetail, ChatMessageRow, Me } from "@/lib/types";

const LABEL = { confirmed: "Confirmed", assumption: "Assumption", tbd: "TBD" } as const;

/** Print-friendly view of a chat (or one answer). The browser's "Save as PDF" turns it into a PDF. */
function PrintView() {
  const { id } = useParams<{ id: string }>();
  const messageId = useSearchParams().get("messageId");
  const [data, setData] = useState<{ chat: ChatDetail; me: Me } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = "light";
    Promise.all([get<ChatDetail>(`/api/chats/${id}`), get<Me>("/api/me")])
      .then(([chat, me]) => setData({ chat, me }))
      .catch((e: Error) => setError(e.message));
  }, [id]);

  const rows: ChatMessageRow[] = !data
    ? []
    : messageId
      ? data.chat.messages.filter((m) => m.id === messageId)
      : pathTo(
          data.chat.messages.map((m) => ({ ...m, parentId: m.parentId ?? null })),
          data.chat.leafMessageId ?? data.chat.messages.at(-1)?.id ?? null,
        ).filter((m) => m.role !== "system" && !m.error);

  useEffect(() => {
    if (!data) return;
    document.title = data.chat.title;
    const t = setTimeout(() => {
      void document.fonts.ready.then(() => window.print());
    }, 400);
    return () => clearTimeout(t);
  }, [data]);

  if (error) return <p className="p-10 text-sm text-fg-muted">{error}</p>;
  if (!data) return <p className="p-10 text-sm text-fg-subtle">Preparing…</p>;
  const product = data.me.org.productName;
  const author = data.chat.readOnly ? (data.chat.authorName ?? "User") : data.me.user.name;

  return (
    <div className="min-h-dvh bg-white text-[#111]">
      <div className="fixed top-4 right-4 print:hidden">
        <button
          onClick={() => window.print()}
          className="inline-flex h-8 items-center gap-2 rounded-lg bg-[#111] px-3 text-[13px] text-white"
        >
          <Printer className="size-3.5" /> Save as PDF
        </button>
      </div>
      <article className="mx-auto max-w-[720px] px-8 py-12 print:px-0 print:py-0">
        <header className="mb-8 border-b border-[#e5e5e5] pb-5">
          <h1 className="font-serif text-[30px] leading-tight tracking-[-0.02em]">{data.chat.title}</h1>
          <p className="mt-1 text-[12.5px] text-[#666]">
            {messageId ? "Answer from" : "Chat with"} {product} · {data.me.org.name} ·{" "}
            {new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}
          </p>
        </header>
        {rows.map((m) => (
          <section key={m.id} className="mb-7 break-inside-avoid-page">
            {!messageId && (
              <div className={`mb-1.5 text-[12px] font-semibold ${m.role === "user" ? "text-[#444]" : "text-[#0e7490]"}`}>
                {m.role === "user" ? author : product}
              </div>
            )}
            {m.role === "user" ? (
              <div className="rounded-lg bg-[#f4f4f4] px-4 py-3 text-[14px] leading-relaxed whitespace-pre-wrap">{m.content}</div>
            ) : (
              <Markdown content={m.content} citations={m.citations} onCite={() => {}} />
            )}
            {m.citations && m.citations.length > 0 && (
              <ol className="mt-3 space-y-0.5 text-[11.5px] text-[#666]">
                {m.citations.map((c) => (
                  <li key={c.n}>
                    [{c.n}] {c.kind === "chat" ? `Earlier chat: ${c.name}` : c.name}
                    {c.page ? `, page ${c.page}` : ""}
                    {c.label ? ` (${LABEL[c.label]})` : ""}
                  </li>
                ))}
              </ol>
            )}
          </section>
        ))}
      </article>
    </div>
  );
}

export default function PrintPage() {
  return (
    <Suspense>
      <PrintView />
    </Suspense>
  );
}
