import { GeistMono } from "geist/font/mono";
import type { Metadata } from "next";
import { Providers } from "./providers";
import "@fontsource-variable/inter";
import "@fontsource/newsreader/400.css";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Aatmiq licensing", template: "%s · Aatmiq licensing" },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={GeistMono.variable}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
