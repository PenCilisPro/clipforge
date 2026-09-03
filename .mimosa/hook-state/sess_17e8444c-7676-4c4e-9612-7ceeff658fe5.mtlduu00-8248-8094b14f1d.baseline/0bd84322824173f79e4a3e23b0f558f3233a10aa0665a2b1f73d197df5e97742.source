"use client";

import { useEffect, useState, type FormEvent } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { apiFetch } from "@/lib/api";
import { PLATFORM_LABELS, type Clip, type Platform } from "@/lib/types";

function defaultLocalTime(): string {
  const target = new Date(Date.now() + 60 * 60 * 1000);
  target.setMinutes(0, 0, 0);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(
    target.getDate()
  )}T${pad(target.getHours())}:${pad(target.getMinutes())}`;
}

export function ScheduleModal({
  clip,
  open,
  onOpenChange,
}: {
  clip: Clip;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [platform, setPlatform] = useState<Platform>("youtube");
  const [scheduledAt, setScheduledAt] = useState(defaultLocalTime);
  const [caption, setCaption] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      const hashtags = clip.hashtags.map((t) => (t.startsWith("#") ? t : `#${t}`));
      setCaption(
        [clip.hook_text ?? clip.title ?? "", hashtags.join(" ")]
          .filter(Boolean)
          .join("\n\n")
      );
      setScheduledAt(defaultLocalTime());
    }
  }, [open, clip]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      // Interpret the datetime-local value in the user's local timezone,
      // convert to UTC ISO before sending.
      const utcIso = new Date(scheduledAt).toISOString();
      await apiFetch("/api/schedule", {
        method: "POST",
        body: {
          clip_id: clip.id,
          platform,
          caption_text: caption,
          scheduled_time_utc: utcIso,
        },
      });
      toast.success("Post scheduled", {
        description: `${PLATFORM_LABELS[platform]} · ${new Date(
          scheduledAt
        ).toLocaleString()}`,
      });
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Scheduling failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule post</DialogTitle>
          <DialogDescription>
            “{clip.title ?? "Clip"}” will be published automatically at the
            time you pick.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Platform</Label>
              <Select value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PLATFORM_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="when">Date &amp; time</Label>
              <Input
                id="when"
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="caption">Caption</Label>
            <Textarea
              id="caption"
              rows={4}
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Write a hook + hashtags…"
            />
            <p className="text-xs text-muted-foreground">
              Pre-filled with the AI-generated hook and hashtags. Stored in
              UTC, shown in your local timezone.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="animate-spin" />}
              Schedule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
