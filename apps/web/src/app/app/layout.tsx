"use client";

import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { LicenseBanner } from "@/components/admin/license";
import { EmailBanner } from "@/components/app/email-banner";
import { AppFrame } from "@/components/app/frame";
import { SessionGate } from "@/components/app/session";
import { Sidebar } from "@/components/app/sidebar";
import { SidebarStateProvider, useSidebarState } from "@/components/app/sidebar-state";

function Shell({ children }: { children: ReactNode }) {
  const { open, setOpen } = useSidebarState();
  return (
    <AppFrame>
      <AnimatePresence initial={false}>
        {open && (
          <>
            <motion.div
              className="fixed inset-0 z-30 bg-black/50 md:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
            />
            <motion.div
              key="sidebar"
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 248, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="fixed inset-y-0 left-0 z-40 shrink-0 overflow-hidden border-r border-border md:relative"
            >
              <div className="h-full w-[248px]">
                <Sidebar onCollapse={() => setOpen(false)} />
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
      <main className="relative flex min-w-0 flex-1 flex-col">
        <LicenseBanner />
        <EmailBanner />
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </main>
    </AppFrame>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionGate>
      <SidebarStateProvider>
        <Shell>{children}</Shell>
      </SidebarStateProvider>
    </SessionGate>
  );
}
