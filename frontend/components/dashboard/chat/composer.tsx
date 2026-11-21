"use client";

/**
 * Chat composer: text input + photo/file attachments. Photos upload to the
 * assets bucket (public URLs the GLM vision model can fetch); text-like
 * files are read client-side and inlined into the message.
 */
import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { FileText, ImagePlus, Loader2, Paperclip, Send, X } from "lucide-react";
import { toast } from "sonner";

import { uploadToR2, publicAssetUrl } from "@/lib/storage";
import { createClient } from "@/lib/supabase/client";
import { safeUploadName } from "@/lib/utils";
import type { ChatImage } from "@/lib/assistant-store";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 2;
const MAX_FILE_CHARS = 16_000;

const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|csv|json|srt|vtt|log|ya?ml|xml|html|css|js|jsx|ts|tsx|py|rb|go|rs|java|c|cpp|h|sh|sql|toml|ini)$/i;

function isTextFile(file: File) {
  return file.type.startsWith("text/") || TEXT_EXTENSIONS.test(file.name);
}

export function Composer({
  sending,
  credits,
  onSend,
}: {
  sending: boolean;
  credits: number | null;
  onSend: (text: string, images: ChatImage[]) => void;
}) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<ChatImage[]>([]);
  const [uploading, setUploading] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const busy = sending || uploading;

  async function handleImagePicked(file: File) {
    if (images.length >= MAX_IMAGES) {
      toast.error(`Up to ${MAX_IMAGES} photos per message`);
      return;
    }
    if (!file.type.startsWith("image/")) {
      toast.error("That's not an image file");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error("Photo is too large — max 5 MB");
      return;
    }
    setUploading(true);
    try {
      const {
        data: { user },
      } = await createClient().auth.getUser();
      if (!user) throw new Error("Not signed in");
      const ext = (file.name.split(".").pop() ?? "png").toLowerCase().replace(/[^a-z0-9]/g, "");
      const path = `${user.id}/chat/${Date.now()}-${safeUploadName(file.name.replace(/\.[^.]+$/, ""))}.${ext}`;
      await uploadToR2("assets", path, file, file.type || "image/png");
      setImages((prev) => [
        ...prev,
        { url: publicAssetUrl(path), name: file.name.slice(0, 60) },
      ]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Photo upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleFilePicked(file: File) {
    if (filesInlined() >= MAX_FILES) {
      toast.error(`Up to ${MAX_FILES} files per message`);
      return;
    }
    if (!isTextFile(file)) {
      toast.error("Only text files are supported (txt, md, csv, json, srt, code…)");
      return;
    }
    if (file.size > MAX_FILE_CHARS * 4) {
      toast.error("File is too large — max ~16,000 characters of text");
      return;
    }
    setUploading(true);
    try {
      const text = (await file.text()).slice(0, MAX_FILE_CHARS);
      const name = file.name.slice(0, 60);
      setInput(
        (prev) =>
          `${prev ? `${prev}\n\n` : ""}[Attached file: ${name}]\n\`\`\`\n${text}\n\`\`\``
      );
    } catch {
      toast.error("Couldn't read that file");
    } finally {
      setUploading(false);
    }
  }

  function filesInlined() {
    // Count fenced [Attached file: ...] blocks in the draft.
    return (input.match(/\[Attached file: /g) ?? []).length;
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const text = input.trim();
    if (!text && images.length === 0) return;
    onSend(text || "What's in these photos?", images);
    setInput("");
    setImages([]);
  }

  return (
    <form onSubmit={onSubmit} className="border-t p-3">
      {images.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {images.map((img) => (
            <div key={img.url} className="group relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.url}
                alt={img.name}
                className="h-14 w-14 rounded-md border object-cover"
              />
              <button
                type="button"
                aria-label={`Remove ${img.name}`}
                className="absolute -right-1.5 -top-1.5 hidden rounded-full bg-destructive p-0.5 text-white group-hover:block"
                onClick={() => setImages((prev) => prev.filter((i) => i.url !== img.url))}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="shrink-0 text-muted-foreground"
              disabled={busy}
              aria-label="Attach a photo or file"
            >
              {uploading ? <Loader2 className="animate-spin" /> : <Paperclip />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => imageInputRef.current?.click()}>
              <ImagePlus /> Upload photo
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
              <FileText /> Attach text file
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Textarea
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit(e);
            }
          }}
          placeholder="Ask the assistant…"
          className="max-h-32 min-h-9 flex-1 resize-none"
          disabled={sending}
        />
        <Button
          type="submit"
          size="icon"
          className="shrink-0"
          disabled={busy || (!input.trim() && images.length === 0)}
        >
          {sending ? <Loader2 className="animate-spin" /> : <Send />}
        </Button>
      </div>
      <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
        {credits != null
          ? `${credits} credits left · 1 per message · failed sends are not charged`
          : "Each message uses 1 credit. Failed sends are not charged."}
      </p>
      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleImagePicked(file);
          e.target.value = "";
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFilePicked(file);
          e.target.value = "";
        }}
      />
    </form>
  );
}
