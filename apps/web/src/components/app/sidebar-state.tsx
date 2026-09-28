"use client";

import { PanelLeft } from "lucide-react";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

const KEY = "aatmiq.sidebar";
const Ctx = createContext<{ open: boolean; setOpen: (v: boolean | ((o: boolean) => boolean)) => void }>({
  open: true,
  setOpen: () => {},
});

export function SidebarStateProvider({ children }: { children: ReactNode }) {
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
      if (window.innerWidth >= 768) localStorage.setItem(KEY, open ? "open" : "closed");
    } catch {}
  }, [open]);
  return <Ctx.Provider value={{ open, setOpen }}>{children}</Ctx.Provider>;
}

export const useSidebarState = () => useContext(Ctx);

/** Shown in the top bar while the sidebar is hidden. */
export function SidebarOpenButton() {
  const { open, setOpen } = useSidebarState();
  if (open) return null;
  return (
    <Button variant="ghost" size="icon-sm" onClick={() => setOpen(true)} aria-label="Open sidebar">
      <PanelLeft className="size-4" />
    </Button>
  );
}
