"use client";

import { ArrowUp, AtSign, Code2, FileText, Lightbulb, Lock, MessageSquare, Mic, PenLine, Plus, Search, Sparkles, SquarePen, Workflow } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { LogoMark } from "@/components/ui/logo";

const PROMPT = "Summarize the vendor contracts in this folder and flag anything renewing soon";

/** A faithful, lightweight replica of the product home for the landing hero. */
export function HeroVisual() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((v) => (v >= PROMPT.length + 60 ? 0 : v + 1)), 45);
    return () => clearInterval(t);
  }, []);
  const typed = PROMPT.slice(0, Math.min(n, PROMPT.length));

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
      className="relative mx-auto w-full max-w-5xl text-left"
    >
      <div className="rounded-2xl border border-border bg-canvas p-1.5 shadow-[0_40px_120px_-40px_rgb(0_0_0/0.7)]">
        <div className="flex h-[440px] overflow-hidden rounded-xl border border-border bg-bg">
          {/* Sidebar */}
          <div className="hidden w-52 shrink-0 flex-col border-r border-border p-2 md:flex">
            <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-surface px-2 text-[12px]">
              <span className="flex size-4 items-center justify-center rounded bg-[linear-gradient(135deg,oklch(0.72_0.15_190),oklch(0.6_0.17_260))] text-[8px] font-semibold text-white">F</span>
              Finance
            </div>
            <div className="mt-2 flex h-8 items-center gap-2 rounded-md border border-border bg-surface px-2 text-[12px] text-fg-subtle">
              <Search className="size-3" /> Search chats
            </div>
            <div className="mt-3 space-y-px text-[12px]">
              {[
                { i: SquarePen, l: "New chat", a: true },
                { i: MessageSquare, l: "Chat" },
                { i: Workflow, l: "Work AI" },
                { i: Code2, l: "Code" },
              ].map(({ i: I, l, a }) => (
                <div key={l} className={`flex h-7 items-center gap-2 rounded-md px-2 ${a ? "bg-surface-2 text-fg" : "text-fg-muted"}`}>
                  <I className="size-3.5 text-fg-subtle" /> {l}
                </div>
              ))}
            </div>
            <div className="mt-4 px-2 text-[11px] text-fg-subtle">Recents</div>
            {["Q3 vendor contracts", "Board deck outline", "GST filing checklist"].map((t) => (
              <div key={t} className="truncate px-2 py-1.5 text-[12px] text-fg-muted">
                {t}
              </div>
            ))}
          </div>
          {/* Main */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-10 items-center justify-between border-b border-border px-3 text-[12px]">
              <span className="flex items-center gap-2 text-fg-muted">
                <SquarePen className="size-3.5" /> New chat
              </span>
              <span className="flex items-center gap-1 text-fg-subtle">
                <Lock className="size-3" /> Private
              </span>
            </div>
            <div className="flex flex-1 flex-col items-center justify-center px-6">
              <div className="font-serif text-[30px] tracking-[-0.02em] text-fg">Good morning, Asha</div>
              <div className="mt-1 text-[11.5px] text-fg-subtle">I&apos;m Aatmiq, where should we start today?</div>
              <div className="mt-5 w-full max-w-lg rounded-xl border border-border-strong bg-surface">
                <div className="min-h-[52px] px-3.5 pt-3 text-[12.5px] text-fg">
                  {typed || <span className="text-fg-subtle">Ask anything, privately…</span>}
                  {n <= PROMPT.length && <span className="ml-px inline-block h-3.5 w-px translate-y-[2px] animate-caret bg-fg" />}
                </div>
                <div className="flex items-center gap-2.5 px-2.5 pb-2 text-[11.5px] text-fg-subtle">
                  <Plus className="size-3.5" />
                  <AtSign className="size-3.5" />
                  <span className="flex items-center gap-1">
                    <Sparkles className="size-3" /> Skills
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="flex -space-x-1">
                      <span className="size-2.5 rounded-full bg-[oklch(0.72_0.14_190)] ring-2 ring-surface" />
                      <span className="size-2.5 rounded-full bg-[oklch(0.72_0.14_330)] ring-2 ring-surface" />
                    </span>
                    Qwen3 · on-prem
                  </span>
                  <span className="flex-1" />
                  <Mic className="size-3.5" />
                  <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-fg">
                    <ArrowUp className="size-3.5" />
                  </span>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap justify-center gap-1.5 text-[11.5px] text-fg-muted">
                {[
                  { i: PenLine, l: "Draft an email" },
                  { i: FileText, l: "Summarize text" },
                  { i: Lightbulb, l: "Brainstorm ideas" },
                ].map(({ i: I, l }) => (
                  <span key={l} className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border px-2">
                    <I className="size-3" /> {l}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-center gap-2 text-[12px] text-fg-subtle">
        <LogoMark className="size-4" /> Running on your own server · 0 bytes sent to third-party AI
      </div>
    </motion.div>
  );
}
