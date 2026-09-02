"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiFetch } from "@/lib/api";
import { CAPTION_STYLES, type Clip, type Clip as ClipType } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Word-highlight caption previews — the highlighted word uses brand orange. */
const PREVIEW_WORDS = ["THIS", "IS", "HOW", "IT", "WORKS"];

function CaptionPreview({ style }: { style: ClipType["caption_style"] }) {
  return (
    <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md bg-zinc-900">
      <div className="flex flex-wrap justify-center gap-0.5 px-2">
        {PREVIEW_WORDS.map((word, i) => {
          const isHighlight = i === 2;
          if (style === "bold-pop") {
            return (
              <span
                key={word}
                className={cn(
                  "rounded-sm px-1 py-0.5 text-[10px] font-extrabold uppercase",
                  isHighlight
                    ? "bg-primary-500 text-white"
                    : "bg-white text-zinc-900"
                )}
              >
                {word}
              </span>
            );
          }
          if (style === "classic") {
            return (
              <span
                key={word}
                className={cn(
                  "text-[10px] font-extrabold",
                  isHighlight ? "text-primary-400" : "text-white"
                )}
                style={{ textShadow: "0 1px 2px rgba(0,0,0,0.8)" }}
              >
                {word}
              </span>
            );
          }
          // karaoke
          return (
            <span
              key={word}
              className={cn(
                "rounded px-1 py-0.5 text-[10px] font-extrabold",
                isHighlight
                  ? "bg-primary-500 text-white"
                  : "text-white"
              )}
              style={!isHighlight ? { textShadow: "0 1px 2px rgba(0,0,0,0.8)" } : undefined}
            >
              {word}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function CaptionStyleDialog({
  clip,
  open,
  onOpenChange,
}: {
  clip: Clip;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [selected, setSelected] = useState<Clip["caption_style"]>(clip.caption_style);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) setSelected(clip.caption_style);
  }, [open, clip.caption_style]);

  async function handleRegenerate() {
    setLoading(true);
    try {
      await apiFetch(`/api/clips/${clip.id}/regenerate`, {
        method: "POST",
        body: { caption_style: selected },
      });
      toast.success("Re-render queued", {
        description: "The clip will be regenerated with the new caption style.",
      });
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to queue re-render");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Regenerate captions</DialogTitle>
          <DialogDescription>
            Pick a caption style and ClipForge re-renders the clip in the
            cloud.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-3">
          {CAPTION_STYLES.map((style) => (
            <button
              key={style.key}
              type="button"
              onClick={() => setSelected(style.key)}
              className={cn(
                "rounded-lg border p-2 text-left transition-all hover:border-primary-500/60",
                selected === style.key &&
                  "border-primary-500 ring-2 ring-primary-500/30"
              )}
            >
              <CaptionPreview style={style.key} />
              <p className="mt-2 text-xs font-semibold">{style.label}</p>
              <p className="text-[11px] leading-tight text-muted-foreground">
                {style.description}
              </p>
            </button>
          ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleRegenerate} disabled={loading}>
            {loading && <Loader2 className="animate-spin" />}
            Regenerate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
