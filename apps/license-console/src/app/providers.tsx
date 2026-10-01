"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Tooltip } from "radix-ui";
import { useState, type ReactNode } from "react";
import { Toaster } from "sonner";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 0, retry: (n, e: any) => n < 2 && !(e?.status >= 400 && e?.status < 500), refetchOnWindowFocus: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <Tooltip.Provider>
        {children}
        <Toaster
          position="bottom-right"
          toastOptions={{ classNames: { toast: "!bg-surface !border-border !text-fg !rounded-xl !shadow-soft", description: "!text-fg-muted" } }}
        />
      </Tooltip.Provider>
    </QueryClientProvider>
  );
}
