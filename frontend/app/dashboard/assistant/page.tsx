"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bot, Loader2, Send, Trash2, User } from "lucide-react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Reveal } from "@/components/dashboard/reveal";
import { cn } from "@/lib/utils";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = [
  "How do I get more viral hooks?",
  "What's the best clip length for TikTok?",
  "How do scheduled uploads work?",
  "How do I connect multiple YouTube channels?",
];

const STORAGE_KEY = "clipforge-assistant-history";

export default function AssistantPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Restore the conversation for this browser.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setMessages(JSON.parse(stored) as ChatMessage[]);
    } catch {
      // Corrupt history — start fresh.
    }
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  function persist(next: ChatMessage[]) {
    setMessages(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next.slice(-40)));
    } catch {
      // Storage full/blocked — in-memory history still works.
    }
  }

  async function send(text: string) {
    const content = text.trim();
    if (!content || sending) return;
    setInput("");
    const next: ChatMessage[] = [
      ...messages,
      { role: "user" as const, content },
    ].slice(-24);
    persist(next);
    setSending(true);
    try {
      const { reply } = await apiFetch<{ reply: string }>("/api/chat", {
        method: "POST",
        body: { messages: next },
      });
      persist([...next, { role: "assistant", content: reply }]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The assistant is unavailable");
      // Drop the optimistic user message so the user can retry cleanly.
      persist(messages);
    } finally {
      setSending(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    send(input);
  }

  return (
    <Reveal className="mx-auto flex h-[calc(100vh-9rem)] w-full max-w-3xl flex-col">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bot className="h-6 w-6 text-primary-500" />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">AI Assistant</h1>
            <p className="text-sm text-muted-foreground">
              Powered by GLM — ask anything about ClipForge or content strategy.
            </p>
          </div>
        </div>
        {messages.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => {
              persist([]);
              try {
                localStorage.removeItem(STORAGE_KEY);
              } catch {}
            }}
          >
            <Trash2 /> Clear
          </Button>
        )}
      </div>

      <Card className="mt-4 flex min-h-0 flex-1 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {messages.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                <Bot className="h-10 w-10 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Ask me anything — clip strategy, publishing, plans…
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => send(suggestion)}
                      className="rounded-lg border px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-primary-500/50 hover:text-foreground"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((message, i) => (
              <div
                key={i}
                className={cn(
                  "flex items-start gap-2.5",
                  message.role === "user" && "flex-row-reverse"
                )}
              >
                <div
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                    message.role === "user"
                      ? "bg-primary-500/15 text-primary-500"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  {message.role === "user" ? (
                    <User className="h-3.5 w-3.5" />
                  ) : (
                    <Bot className="h-3.5 w-3.5" />
                  )}
                </div>
                <div
                  className={cn(
                    "max-w-[80%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm",
                    message.role === "user"
                      ? "rounded-tr-sm bg-primary-500/15"
                      : "rounded-tl-sm bg-muted"
                  )}
                >
                  {message.content}
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Thinking…
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          <form onSubmit={onSubmit} className="border-t p-3">
            <div className="flex items-end gap-2">
              <Textarea
                rows={1}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send(input);
                  }
                }}
                placeholder="Ask the assistant… (1 credit per message)"
                className="max-h-32 min-h-9 flex-1 resize-none"
                disabled={sending}
              />
              <Button type="submit" size="icon" disabled={sending || !input.trim()}>
                <Send />
              </Button>
            </div>
            <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
              Each message uses 1 credit. Failed sends are not charged.
            </p>
          </form>
        </CardContent>
      </Card>
    </Reveal>
  );
}
