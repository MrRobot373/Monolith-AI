"use client";

import { Check, Copy } from "lucide-react";
import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { Citation } from "@/lib/types";
import { CitationChip, linkCitations } from "./citations";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const lang = /language-(\w+)/.exec(className ?? "")?.[1];
  return (
    <div className="group/code overflow-hidden rounded-xl border border-border bg-bg-subtle">
      <div className="flex h-9 items-center justify-between border-b border-border px-3.5">
        <span className="font-mono text-[11.5px] text-fg-subtle">{lang ?? "text"}</span>
        <button
          onClick={() => {
            navigator.clipboard.writeText(textOf(children).replace(/\n$/, ""));
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg print:hidden"
        >
          {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({
  content,
  citations,
  onCite,
}: {
  content: string;
  citations?: Citation[] | null;
  onCite?: (c: Citation) => void;
}) {
  return (
    <div className="prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children, ...props }) => {
            const isBlock = /language-/.test(className ?? "") || String(children).includes("\n");
            if (isBlock) return <CodeBlock className={className}>{children}</CodeBlock>;
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          a: ({ children, href }) => {
            const n = href?.startsWith("#cite-") ? Number(href.slice(6)) : null;
            const c = n ? citations?.find((x) => x.n === n) : undefined;
            if (c) return <CitationChip citation={c} onOpen={(x) => onCite?.(x)} />;
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
        }}
      >
        {linkCitations(content, citations)}
      </ReactMarkdown>
    </div>
  );
});
