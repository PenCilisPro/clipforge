"use client";

/**
 * One chat bubble. Assistant replies render as markdown; user messages may
 * carry uploaded image thumbnails. Entrance animation via framer-motion.
 */
import { motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, Check, Copy, User } from "lucide-react";
import { useState } from "react";

import type { ChatMessage } from "@/lib/assistant-store";
import { cn } from "@/lib/utils";

const markdownComponents = {
  p: (props: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className="my-1.5 first:mt-0 last:mb-0" {...props} />
  ),
  ul: (props: React.HTMLAttributes<HTMLUListElement>) => (
    <ul className="my-1.5 list-disc space-y-1 pl-4" {...props} />
  ),
  ol: (props: React.HTMLAttributes<HTMLOListElement>) => (
    <ol className="my-1.5 list-decimal space-y-1 pl-4" {...props} />
  ),
  li: (props: React.HTMLAttributes<HTMLLIElement>) => <li className="leading-relaxed" {...props} />,
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      className="text-primary-600 underline underline-offset-2 dark:text-primary-400"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  h1: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h1 className="mt-2 text-base font-bold first:mt-0" {...props} />
  ),
  h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 className="mt-2 text-sm font-bold first:mt-0" {...props} />
  ),
  h3: (props: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3 className="mt-2 text-sm font-semibold first:mt-0" {...props} />
  ),
  blockquote: (props: React.HTMLAttributes<HTMLQuoteElement>) => (
    <blockquote className="my-1.5 border-l-2 border-primary-500/50 pl-2 text-muted-foreground" {...props} />
  ),
  table: (props: React.HTMLAttributes<HTMLTableElement>) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="w-full border-collapse text-xs" {...props} />
    </div>
  ),
  th: (props: React.HTMLAttributes<HTMLTableCellElement>) => (
    <th className="border px-1.5 py-1 text-left font-semibold" {...props} />
  ),
  td: (props: React.HTMLAttributes<HTMLTableCellElement>) => (
    <td className="border px-1.5 py-1" {...props} />
  ),
  pre: (props: React.HTMLAttributes<HTMLPreElement>) => (
    <pre
      className="my-1.5 overflow-x-auto rounded-lg bg-zinc-900 p-2.5 text-[11px] leading-relaxed text-zinc-100 dark:bg-zinc-900"
      {...props}
    />
  ),
  code: (props: React.HTMLAttributes<HTMLElement>) => {
    // Block code (inside pre) vs inline code.
    const isBlock = "data-language" in (props as Record<string, unknown>);
    if (isBlock) return <code {...props} />;
    return (
      <code
        className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]"
        {...props}
      />
    );
  },
};

export function MessageBubble({
  message,
  streaming = false,
}: {
  message: ChatMessage;
  /** True while tokens are still arriving — shows a blinking caret. */
  streaming?: boolean;
}) {
  const isUser = message.role === "user";
  const [copied, setCopied] = useState(false);
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.21, 0.47, 0.32, 0.98] }}
      className={cn("flex items-start gap-2.5", isUser && "flex-row-reverse")}
    >
      <div
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
          isUser ? "bg-primary-500/15 text-primary-500" : "bg-muted text-muted-foreground"
        )}
      >
        {isUser ? <User className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
      </div>
      <div className={cn("max-w-[80%] space-y-2", isUser && "items-end text-right")}>
        {message.images && message.images.length > 0 && (
          <div
            className={cn(
              "grid max-w-[280px] gap-1.5",
              message.images.length === 1 ? "grid-cols-1" : "grid-cols-2"
            )}
          >
            {message.images.map((img) => (
              <a key={img.url} href={img.url} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.url}
                  alt={img.name}
                  className="h-28 w-full rounded-lg border object-cover transition-transform hover:scale-[1.02]"
                  loading="lazy"
                />
              </a>
            ))}
          </div>
        )}
        {message.content && (
          <div
            className={cn(
              "group relative rounded-2xl px-3.5 py-2.5 text-sm",
              isUser
                ? "rounded-tr-sm whitespace-pre-wrap bg-primary-500/15"
                : "rounded-tl-sm bg-muted [&_a]:break-all"
            )}
          >
            {isUser ? (
              message.content
            ) : (
              <>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {message.content}
                </ReactMarkdown>
                {streaming && (
                  <span
                    aria-hidden
                    className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-[2px] animate-pulse rounded-sm bg-primary-500"
                  />
                )}
                {/* Copy on hover — daily-use staple, invisible while streaming */}
                {!streaming && (
                  <button
                    type="button"
                    aria-label="Copy reply"
                    title="Copy"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(message.content);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                      } catch {
                        // Clipboard blocked — do nothing.
                      }
                    }}
                    className="absolute -top-2 right-2 hidden rounded-md border bg-background p-1 text-muted-foreground shadow-sm transition-colors hover:text-foreground group-hover:block"
                  >
                    {copied ? (
                      <Check className="h-3 w-3 text-emerald-500" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </motion.div>
  );
}
