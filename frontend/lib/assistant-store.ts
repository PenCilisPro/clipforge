/**
 * Browser-local storage for AI assistant chat threads (ChatGPT-style).
 * Threads live entirely in localStorage — per user's choice, no DB.
 * Caps keep the payload well under the ~5 MB localStorage budget.
 */

export interface ChatImage {
  url: string;
  name: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  images?: ChatImage[];
  createdAt: number;
}

export interface ChatThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

interface AssistantStore {
  threads: ChatThread[];
  activeId: string | null;
}

export const MAX_THREADS = 20;
export const MAX_MESSAGES_PER_THREAD = 40;

const STORAGE_KEY = "clipforge-assistant-threads";

function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Derive a thread title from its first user message. */
export function titleFromMessage(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "New chat";
  return clean.length > 48 ? `${clean.slice(0, 48).trimEnd()}…` : clean;
}

export function loadStore(): AssistantStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { threads: [], activeId: null };
    const parsed = JSON.parse(raw) as AssistantStore;
    if (!Array.isArray(parsed.threads)) return { threads: [], activeId: null };
    return {
      threads: parsed.threads.slice(0, MAX_THREADS),
      activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
    };
  } catch {
    // Corrupt or blocked storage — start fresh.
    return { threads: [], activeId: null };
  }
}

export function saveStore(store: AssistantStore) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Quota exceeded or storage blocked — keep working in memory.
  }
}

export function newThread(): ChatThread {
  const now = Date.now();
  return { id: uuid(), title: "New chat", createdAt: now, updatedAt: now, messages: [] };
}

/**
 * Apply a mutation to the thread list with all caps enforced: trims each
 * thread's messages, drops the oldest threads past MAX_THREADS, re-sorts by
 * recent activity and returns the normalized store.
 */
export function normalize(threads: ChatThread[], activeId: string | null): AssistantStore {
  const trimmed = threads
    .slice(0, MAX_THREADS)
    .map((t) => ({ ...t, messages: t.messages.slice(-MAX_MESSAGES_PER_THREAD) }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const exists = trimmed.some((t) => t.id === activeId);
  return { threads: trimmed, activeId: exists ? activeId : (trimmed[0]?.id ?? null) };
}

export { uuid as chatUuid };
