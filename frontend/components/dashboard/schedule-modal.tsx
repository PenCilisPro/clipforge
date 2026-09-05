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
import { createClient } from "@/lib/supabase/client";
import { PLATFORM_LABELS, type Clip, type Platform, type SocialConnection } from "@/lib/types";

/** Default to the preset day (calendar "+") or the next full hour. */
function defaultLocalTime(presetDate?: Date | null): string {
  const target = presetDate
    ? new Date(presetDate.getFullYear(), presetDate.getMonth(), presetDate.getDate(), 12, 0, 0, 0)
    : new Date(Date.now() + 60 * 60 * 1000);
  if (!presetDate) target.setMinutes(0, 0, 0);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(
    target.getDate()
  )}T${pad(target.getHours())}:${pad(target.getMinutes())}`;
}

export function ScheduleModal({
  clip,
  presetDate,
  open,
  onOpenChange,
}: {
  /** Omit when opened without a specific clip — a picker is shown instead. */
  clip?: Clip | null;
  /** Pre-fills the date (calendar quick-schedule). */
  presetDate?: Date | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [clipOptions, setClipOptions] = useState<Clip[] | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string>("");
  const [platform, setPlatform] = useState<Platform>("youtube");
  const [channels, setChannels] = useState<SocialConnection[]>([]);
  const [channelId, setChannelId] = useState<string>("");
  const [scheduledAt, setScheduledAt] = useState(defaultLocalTime(presetDate));
  const [caption, setCaption] = useState("");
  const [loading, setLoading] = useState(false);

  const activeClip = clip ?? clipOptions?.find((c) => c.id === selectedClipId) ?? null;
  const platformChannels = channels.filter((c) => c.platform === platform);

  useEffect(() => {
    if (!open) return;
    setScheduledAt(defaultLocalTime(presetDate));
    setSelectedClipId("");
    const supabase = createClient();
    // Channels for the platform selector (users may connect several).
    supabase
      .from("social_connections")
      .select("id, platform, platform_account_id, platform_username, connected_at")
      .then(({ data }) =>
        setChannels((data as SocialConnection[]) ?? [])
      );
    if (!clip) {
      // Calendar flow — offer every ready clip of the user.
      supabase
        .from("clips")
        .select("id, title, hook_text, hashtags, status, project_id, caption_style, caption_font")
        .eq("status", "ready")
        .order("created_at", { ascending: false })
        .limit(50)
        .then(({ data }) => setClipOptions((data as Clip[]) ?? []));
    }
  }, [open, clip, presetDate]);

  // Reset the channel pick when the platform changes.
  useEffect(() => {
    setChannelId("");
  }, [platform]);

  // Prefill the caption whenever the active clip changes.
  useEffect(() => {
    if (!open || !activeClip) return;
    const hashtags = activeClip.hashtags.map((t) => (t.startsWith("#") ? t : `#${t}`));
    setCaption(
      [activeClip.hook_text ?? activeClip.title ?? "", hashtags.join(" ")]
        .filter(Boolean)
        .join("\n\n")
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeClip?.id]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!activeClip) return;
    setLoading(true);
    try {
      // Interpret the datetime-local value in the user's local timezone,
      // convert to UTC ISO before sending.
      const utcIso = new Date(scheduledAt).toISOString();
      await apiFetch("/api/schedule", {
        method: "POST",
        body: {
          clip_id: activeClip.id,
          platform,
          connection_id: channelId || undefined,
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
            {activeClip
              ? `“${activeClip.title ?? "Clip"}” will be published automatically at the time you pick.`
              : "Choose a finished clip and when it should go out."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {!clip && (
            <div className="space-y-1.5">
              <Label>Video clip</Label>
              {clipOptions == null ? (
                <div className="flex h-9 items-center justify-center rounded-md border text-xs text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading clips…
                </div>
              ) : clipOptions.length === 0 ? (
                <div className="flex h-9 items-center justify-center rounded-md border text-xs text-muted-foreground">
                  No finished clips yet — render one first
                </div>
              ) : (
                <Select value={selectedClipId} onValueChange={setSelectedClipId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a clip" />
                  </SelectTrigger>
                  <SelectContent>
                    {clipOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.title ?? "Untitled clip"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

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

          {platformChannels.length > 1 && (
            <div className="space-y-1.5">
              <Label>Channel</Label>
              <Select value={channelId || "default"} onValueChange={setChannelId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">
                    Default (first connected channel)
                  </SelectItem>
                  {platformChannels.map((channel) => (
                    <SelectItem key={channel.id} value={channel.id}>
                      @{channel.platform_username ?? channel.platform_account_id ?? "channel"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

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
            <Button type="submit" disabled={loading || !activeClip}>
              {loading && <Loader2 className="animate-spin" />}
              Schedule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
