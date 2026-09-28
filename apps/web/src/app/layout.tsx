import { GeistMono } from "geist/font/mono";
import type { Metadata, Viewport } from "next";
import { themeBootScript } from "@/lib/theme";
import { Providers } from "./providers";
import "@fontsource-variable/inter";
import "@fontsource/newsreader/400.css";
import "@fontsource/newsreader/400-italic.css";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Aatmiq: your own AI", template: "%s · Aatmiq" },
  description:
    "Aatmiq is a private AI workplace for your organization: chat, agents and code, running on your own servers with open-source models.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#1c1c1c" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={GeistMono.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
