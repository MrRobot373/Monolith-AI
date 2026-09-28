"use client";

import { PanelLeftOpen } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { SessionGate } from "@/components/app/session";
import { Sidebar } from "@/components/app/sidebar";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/ui/logo";

const KEY = "aatmiq.sidebar";

export default function AppLayout({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) === "closed" || window.innerWidth < 768) setOpen(false);
    } catch {}
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, open ? "open" : "closed");
    } catch {}
  }, [open]);

  return (
    <SessionGate>
      <div className="flex h-dvh overflow-hidden">
        <AnimatePresence initial={false}>
          {open && (
            <>
              <motion.div
                className="fixed inset-0 z-30 bg-black/40 md:hidden"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setOpen(false)}
              />
              <motion.div
                key="sidebar"
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 264, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                className="fixed inset-y-0 left-0 z-40 shrink-0 overflow-hidden border-r border-border md:relative"
              >
                <div className="h-full w-[264px]">
                  <Sidebar onCollapse={() => setOpen(false)} />
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
        <main className="relative flex min-w-0 flex-1 flex-col">
          {!open && (
            <div className="absolute top-2.5 left-2.5 z-20 flex items-center gap-1">
              <Button variant="ghost" size="icon-sm" onClick={() => setOpen(true)} aria-label="Open sidebar">
                <PanelLeftOpen className="size-4" />
              </Button>
              <LogoMark className="ml-1 size-5" />
            </div>
          )}
          {children}
        </main>
      </div>
    </SessionGate>
  );
}
