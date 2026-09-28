"use client";

import { motion } from "motion/react";
import { Code2, FolderGit2, MessageSquare, Sparkles, Terminal, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { LogoMark } from "@/components/ui/logo";

const ANSWER =
  "Here's a summary of the Q3 vendor contracts. Three renew in October; the Acme hosting contract has a 12% price increase clause worth reviewing before the 14th.";

/** A live-looking product window for the landing hero (pure HTML/CSS, no screenshots). */
export function HeroVisual() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((v) => (v >= ANSWER.length + 40 ? 0 : v + 2)), 30);
    return () => clearInterval(t);
  }, []);
  const shown = ANSWER.slice(0, Math.min(n, ANSWER.length));

  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1], delay: 0.15 }}
      className="relative mx-auto w-full max-w-5xl text-left"
    >
      <div className="pointer-events-none absolute -inset-x-10 -top-16 bottom-0 -z-10 bg-[radial-gradient(60%_50%_at_50%_0%,color-mix(in_oklab,var(--accent)_22%,transparent),transparent_70%)]" />
      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_40px_120px_-40px_rgb(0_0_0/0.6)]">
        {/* window bar */}
        <div className="flex h-10 items-center gap-2 border-b border-border px-4">
          <span className="size-2.5 rounded-full bg-surface-3" />
          <span className="size-2.5 rounded-full bg-surface-3" />
          <span className="size-2.5 rounded-full bg-surface-3" />
          <div className="mx-auto rounded-md bg-surface-2 px-3 py-0.5 font-mono text-[11px] text-fg-subtle">ai.yourcompany.com</div>
        </div>
        <div className="grid grid-cols-[200px_1fr] max-md:grid-cols-1">
          {/* sidebar */}
          <div className="border-r border-border bg-bg-subtle p-3 max-md:hidden">
            <div className="mb-4 flex items-center gap-2 px-1">
              <LogoMark className="size-5" />
              <span className="text-[13px] font-semibold">Finance</span>
            </div>
            {[
              { i: MessageSquare, l: "Chat", a: true },
              { i: Workflow, l: "Work AI" },
              { i: Code2, l: "Code" },
            ].map(({ i: I, l, a }) => (
              <div
                key={l}
                className={`mb-0.5 flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] ${a ? "bg-surface-2 text-fg" : "text-fg-muted"}`}
              >
                <I className="size-3.5" /> {l}
              </div>
            ))}
            <div className="mt-4 mb-1.5 px-2 text-[10px] font-medium tracking-wide text-fg-subtle uppercase">Today</div>
            {["Q3 vendor contracts", "Board deck outline", "GST filing checklist"].map((t, i) => (
              <div key={t} className={`truncate rounded-md px-2 py-1.5 text-[12px] ${i === 0 ? "text-fg" : "text-fg-muted"}`}>
                {t}
              </div>
            ))}
          </div>
          {/* chat */}
          <div className="flex min-h-[340px] flex-col p-5 sm:p-7">
            <div className="ml-auto max-w-[80%] rounded-2xl rounded-br-md bg-surface-2 px-4 py-2.5 text-[13px]">
              Summarize the vendor contracts in this folder and flag anything renewing soon.
              <div className="mt-2 flex gap-1.5">
                <span className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">contracts.zip</span>
              </div>
            </div>
            <div className="mt-5 flex gap-3">
              <LogoMark className="mt-0.5 size-6 shrink-0" />
              <p className="text-[13.5px] leading-relaxed text-fg">
                {shown}
                {n < ANSWER.length && <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-[3px] animate-caret bg-accent" />}
              </p>
            </div>
            <div className="mt-auto pt-6">
              <div className="flex items-center gap-2 rounded-xl border border-border bg-bg-subtle px-3 py-2.5">
                <span className="flex-1 text-[12.5px] text-fg-subtle">Ask anything, privately…</span>
                <span className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10.5px] text-fg-muted">
                  <Sparkles className="size-3 text-accent" /> Qwen3 · on-prem
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* floating chips */}
      <motion.div
        initial={{ opacity: 0, x: -12 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: 0.9, duration: 0.5 }}
        className="absolute -top-5 left-10 hidden items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-[12px] shadow-soft lg:flex"
      >
        <Terminal className="size-3.5 text-accent" /> Agent ran <span className="font-mono text-fg-muted">pnpm test</span>
      </motion.div>
      <motion.div
        initial={{ opacity: 0, x: 12 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: 1.1, duration: 0.5 }}
        className="absolute right-10 -bottom-5 hidden items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-[12px] shadow-soft lg:flex"
      >
        <FolderGit2 className="size-3.5 text-accent" /> 0 bytes sent to third-party AI
      </motion.div>
    </motion.div>
  );
}
