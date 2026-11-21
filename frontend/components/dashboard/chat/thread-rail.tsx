"use client";

/**
 * Left rail of assistant chat threads (ChatGPT-style conversation list).
 * Rendered inside the page's desktop aside and mobile drawer alike.
 */
import { AnimatePresence, motion } from "framer-motion";
import { MessageSquarePlus, Trash2 } from "lucide-react";
import type { ChatThread } from "@/lib/assistant-store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function relativeTime(ts: number) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function ThreadRail({
  threads,
  activeId,
  onSelect,
  onNew,
  onDelete,
}: {
  threads: ChatThread[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b p-3">
        <Button onClick={onNew} className="w-full" size="sm">
          <MessageSquarePlus /> New chat
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {threads.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No conversations yet — start one below.
          </p>
        )}
        <AnimatePresence initial={false}>
          {threads.map((thread) => {
            const active = thread.id === activeId;
            return (
              <motion.div
                key={thread.id}
                layout
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18 }}
              >
                <button
                  type="button"
                  onClick={() => onSelect(thread.id)}
                  className={cn(
                    "group mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                    active
                      ? "bg-primary-500/10 text-primary-700 dark:text-primary-300"
                      : "text-foreground/80 hover:bg-accent"
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{thread.title}</span>
                    <span className="block text-[10px] text-muted-foreground">
                      {thread.messages.length} message{thread.messages.length === 1 ? "" : "s"} ·{" "}
                      {relativeTime(thread.updatedAt)}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label={`Delete chat "${thread.title}"`}
                    className={cn(
                      "rounded p-1 text-muted-foreground transition-opacity hover:text-destructive md:opacity-0 group-hover:opacity-100",
                      active && "opacity-100"
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      // A conversation is unrecoverable — never on one click.
                      if (
                        window.confirm(
                          `Delete the chat "${thread.title}"? This can't be undone.`
                        )
                      ) {
                        onDelete(thread.id);
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}
