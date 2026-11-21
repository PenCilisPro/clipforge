"use client";

/**
 * AI Assistant — ChatGPT-style multi-thread chat (browser-local storage),
 * photo/file attachments, markdown replies and smooth animations.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, PanelLeft, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api";
import {
  chatUuid,
  loadStore,
  newThread,
  normalize,
  saveStore,
  titleFromMessage,
  type ChatImage,
  type ChatThread,
} from "@/lib/assistant-store";
import { ThreadRail } from "@/components/dashboard/chat/thread-rail";
import { MessageBubble } from "@/components/dashboard/chat/message-bubble";
import { Composer } from "@/components/dashboard/chat/composer";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const SUGGESTIONS = [
  "How do I get more viral hooks?",
  "What's the best clip length for TikTok?",
  "How do scheduled uploads work?",
  "How do I connect multiple YouTube channels?",
  "Give me caption ideas for a fitness podcast",
  "What makes a thumbnail clickable?",
];

/** Stored thread message → API message (images become OpenAI-style parts). */
function toApiMessages(thread: ChatThread) {
  return thread.messages.slice(-24).map((m) => {
    if (m.role === "user" && m.images && m.images.length > 0) {
      const parts: Array<
        { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
      > = [{ type: "text", text: m.content || "What's in these photos?" }];
      for (const img of m.images) {
        parts.push({ type: "image_url", image_url: { url: img.url } });
      }
      return { role: m.role, content: parts };
    }
    return { role: m.role, content: m.content };
  });
}

function ThinkingDots() {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Bot className="h-3.5 w-3.5" />
      </div>
      <div className="flex items-center gap-1 rounded-2xl rounded-tl-sm bg-muted px-3.5 py-3">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-chat-dot"
            style={{ animationDelay: `${i * 0.18}s` }}
          />
        ))}
      </div>
    </div>
  );
}

export default function AssistantPage() {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [credits, setCredits] = useState<number | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const storeRef = useRef<{ threads: ChatThread[]; activeId: string | null }>({
    threads: [],
    activeId: null,
  });

  const commit = useCallback((next: { threads: ChatThread[]; activeId: string | null }) => {
    const normalized = normalize(next.threads, next.activeId);
    storeRef.current = { threads: normalized.threads, activeId: normalized.activeId };
    setThreads(normalized.threads);
    setActiveId(normalized.activeId);
    saveStore(normalized);
  }, []);

  // Restore this browser's threads + fetch current credits.
  useEffect(() => {
    const stored = loadStore();
    commit(stored);
    apiFetch<{ profile: { credits_remaining: number } }>("/api/me")
      .then(({ profile }) => setCredits(profile.credits_remaining))
      .catch(() => {});
  }, [commit]);

  const activeThread = threads.find((t) => t.id === activeId) ?? null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeThread?.messages.length, sending, activeId]);

  function updateThread(id: string, updater: (t: ChatThread) => ChatThread) {
    const next = storeRef.current.threads.map((t) => (t.id === id ? updater(t) : t));
    commit({ threads: next, activeId: storeRef.current.activeId });
  }

  function handleNew() {
    // Reuse the current thread if it's still empty (no duplicate blanks).
    const empty = threads.find((t) => t.messages.length === 0);
    if (empty) {
      commit({ threads, activeId: empty.id });
    } else {
      const thread = newThread();
      commit({ threads: [thread, ...threads], activeId: thread.id });
    }
    setRailOpen(false);
  }

  function handleDelete(id: string) {
    const remaining = threads.filter((t) => t.id !== id);
    commit({ threads: remaining, activeId: storeRef.current.activeId });
    if (!storeRef.current.activeId && remaining.length === 0) {
      const thread = newThread();
      commit({ threads: [thread], activeId: thread.id });
    }
  }

  async function send(text: string, images: ChatImage[]) {
    if (sending) return;

    // Resolve (or lazily create) the target thread synchronously.
    let target = storeRef.current.threads.find((t) => t.id === storeRef.current.activeId);
    if (!target) {
      target = newThread();
      commit({ threads: [target, ...storeRef.current.threads], activeId: target.id });
    }
    const threadId = target.id;
    const isFirstMessage = target.messages.length === 0;

    const optimistic = {
      id: chatUuid(),
      role: "user" as const,
      content: text,
      images: images.length > 0 ? images : undefined,
      createdAt: Date.now(),
    };
    updateThread(threadId, (t) => ({
      ...t,
      title: isFirstMessage ? titleFromMessage(text || "Photos") : t.title,
      updatedAt: Date.now(),
      messages: [...t.messages, optimistic],
    }));
    setSending(true);
    try {
      const snapshot = storeRef.current.threads.find((t) => t.id === threadId);
      if (!snapshot) throw new Error("Thread vanished");
      const { reply, credits_remaining } = await apiFetch<{
        reply: string;
        credits_remaining: number | null;
      }>("/api/chat", {
        method: "POST",
        body: { messages: toApiMessages(snapshot) },
      });
      if (credits_remaining != null) setCredits(credits_remaining);
      updateThread(threadId, (t) => ({
        ...t,
        updatedAt: Date.now(),
        messages: [
          ...t.messages,
          { id: chatUuid(), role: "assistant", content: reply, createdAt: Date.now() },
        ],
      }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The assistant is unavailable");
      // Drop the optimistic message so the user can retry cleanly.
      updateThread(threadId, (t) => ({
        ...t,
        messages: t.messages.filter((m) => m.id !== optimistic.id),
      }));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-8rem)] w-full max-w-5xl gap-4">
      {/* Desktop thread rail */}
      <aside className="hidden w-60 shrink-0 md:block">
        <Card className="h-full overflow-hidden">
          <ThreadRail
            threads={threads}
            activeId={activeId}
            onSelect={(id) => commit({ threads, activeId: id })}
            onNew={handleNew}
            onDelete={handleDelete}
          />
        </Card>
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {railOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/50 md:hidden"
            onClick={() => setRailOpen(false)}
          >
            <motion.div
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: "spring", damping: 26, stiffness: 300 }}
              className="h-full w-72 bg-background p-3 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <Card className="h-full overflow-hidden">
                <ThreadRail
                  threads={threads}
                  activeId={activeId}
                  onSelect={(id) => {
                    commit({ threads, activeId: id });
                    setRailOpen(false);
                  }}
                  onNew={handleNew}
                  onDelete={handleDelete}
                />
              </Card>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Chat column */}
      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <div className="flex items-center justify-between border-b p-3">
            <div className="flex min-w-0 items-center gap-2">
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0 md:hidden"
                aria-label="Open chat list"
                onClick={() => setRailOpen(true)}
              >
                <PanelLeft className="h-4 w-4" />
              </Button>
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-500/10">
                <Bot className="h-4 w-4 text-primary-500" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold">
                  {activeThread?.title ?? "AI Assistant"}
                </h1>
                <p className="truncate text-[11px] text-muted-foreground">
                  Powered by GLM — photos welcome
                </p>
              </div>
            </div>
            {activeThread && activeThread.messages.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 text-muted-foreground"
                aria-label="Clear this conversation"
                onClick={() =>
                  updateThread(activeThread.id, (t) => ({ ...t, messages: [], updatedAt: Date.now() }))
                }
              >
                <Trash2 className="h-4 w-4" />
                <span className="hidden sm:inline">Clear</span>
              </Button>
            )}
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {(!activeThread || activeThread.messages.length === 0) && (
              <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                <motion.div
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ duration: 0.35 }}
                  className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-500/10"
                >
                  <Bot className="h-7 w-7 text-primary-500" />
                </motion.div>
                <div>
                  <p className="font-medium">Ask me anything</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Clip strategy, publishing, plans — or drop in a photo.
                  </p>
                </div>
                <div className="grid w-full max-w-md gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((suggestion, i) => (
                    <motion.button
                      key={suggestion}
                      type="button"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.05 * i, duration: 0.25 }}
                      onClick={() => send(suggestion, [])}
                      className="rounded-lg border px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-primary-500/50 hover:text-foreground"
                    >
                      {suggestion}
                    </motion.button>
                  ))}
                </div>
              </div>
            )}
            {activeThread?.messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            <AnimatePresence>{sending && <ThinkingDots />}</AnimatePresence>
            <div ref={bottomRef} />
          </div>

          <Composer sending={sending} credits={credits} onSend={send} />
        </CardContent>
      </Card>
    </div>
  );
}
