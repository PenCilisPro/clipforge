"use client";

import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Reply, Send, X } from "lucide-react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { formatDateTime } from "@/lib/utils";
import { FEEDBACK_CATEGORIES, categoryLabel, type FeedbackCategory } from "@/lib/feedback";
import { Reveal } from "@/components/dashboard/reveal";
import { StarRating } from "@/components/dashboard/star-rating";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB

interface FeedbackRow {
  id: string;
  message: string;
  category?: string;
  rating?: number | null;
  screenshot_path?: string | null;
  admin_reply?: string | null;
  admin_replied_at?: string | null;
  created_at: string;
}

export default function FeedbackPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState<FeedbackCategory>("general");
  const [rating, setRating] = useState<number | null>(null);
  const [contactEmail, setContactEmail] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [history, setHistory] = useState<FeedbackRow[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      // RLS lets users read back only their own feedback.
      const { data } = await supabase
        .from("feedback")
        .select(
          "id, message, category, rating, screenshot_path, admin_reply, admin_replied_at, created_at"
        )
        .order("created_at", { ascending: false })
        .limit(20);
      setHistory((data as FeedbackRow[]) ?? []);
      setHistoryLoaded(true);
    })();
  }, []);

  function pickImage(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Attachments must be images (PNG, JPG, WebP…)");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast.error("Image must be under 20 MB");
      return;
    }
    setImage(file);
    setImagePreview(URL.createObjectURL(file));
  }

  function clearImage() {
    setImage(null);
    setImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function submit() {
    if (!message.trim() || !rating || submitting) return;
    setSubmitting(true);
    try {
      let screenshotPath: string | null = null;
      const supabase = createClient();

      if (image) {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) throw new Error("Not signed in");
        const ext = (image.name.split(".").pop() ?? "png").toLowerCase().replace(/[^a-z0-9]/g, "");
        screenshotPath = `${user.id}/feedback-${Date.now()}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from("assets")
          .upload(screenshotPath, image, { contentType: image.type, upsert: false });
        if (uploadError) throw uploadError;
      }

      await apiFetch("/api/feedback", {
        method: "POST",
        body: {
          message: message.trim(),
          category,
          rating,
          contact_email: contactEmail.trim(),
          screenshot_path: screenshotPath,
        },
      });
      setHistory((prev) => [
        {
          id: crypto.randomUUID(),
          message: message.trim(),
          category,
          rating,
          screenshot_path: screenshotPath,
          created_at: new Date().toISOString(),
        },
        ...prev,
      ]);
      setMessage("");
      setRating(null);
      setCategory("general");
      setContactEmail("");
      clearImage();
      toast.success("Thanks — feedback sent!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send feedback");
    } finally {
      setSubmitting(false);
    }
  }

  const supabase = createClient();

  return (
    <Reveal className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Feedback</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Anything broken, confusing, or missing? Tell us — it goes straight to the team.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Category</Label>
              <Select
                value={category}
                onValueChange={(v) => setCategory(v as FeedbackCategory)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FEEDBACK_CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">How would you rate ClipForge?</Label>
              <div className="flex h-9 items-center">
                <StarRating value={rating} onChange={setRating} />
              </div>
            </div>
          </div>
          <Textarea
            rows={6}
            placeholder={
              category === "bug_report"
                ? "What happened, and what did you expect instead?"
                : category === "feature_request"
                  ? "What would you love ClipForge to do?"
                  : "What's on your mind?"
            }
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Your email (optional)</Label>
              <Input
                type="email"
                placeholder="you@example.com"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Only if you'd like a personal reply.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Screenshot (optional, &lt; 20 MB)</Label>
              {imagePreview ? (
                <div className="flex items-center gap-2 rounded-lg border p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={imagePreview}
                    alt="Attachment preview"
                    className="h-10 w-10 rounded object-cover"
                  />
                  <p className="min-w-0 flex-1 truncate text-xs">{image?.name}</p>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    aria-label="Remove attachment"
                    onClick={clearImage}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImagePlus /> Attach image
                </Button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={pickImage}
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={submit} disabled={submitting || !message.trim() || !rating}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {submitting ? "Sending…" : "Send feedback"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {historyLoaded && history.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Your previous feedback</h2>
          {history.map((row, i) => {
            const screenshotUrl = row.screenshot_path
              ? supabase.storage.from("assets").getPublicUrl(row.screenshot_path).data.publicUrl
              : null;
            return (
              <Reveal key={row.id} delay={i * 0.05}>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{categoryLabel(row.category)}</Badge>
                      {row.rating != null && <StarRating value={row.rating} size="sm" />}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {formatDateTime(row.created_at)}
                      </span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-sm">{row.message}</p>
                    {screenshotUrl && (
                      <a href={screenshotUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={screenshotUrl}
                          alt="Attached screenshot"
                          className="max-h-32 rounded-lg border object-cover"
                        />
                      </a>
                    )}
                    {row.admin_reply && (
                      <div className="mt-3 rounded-lg border-l-2 border-primary-500 bg-primary-500/5 p-3">
                        <p className="flex items-center gap-1.5 text-xs font-semibold text-primary-600 dark:text-primary-400">
                          <Reply className="h-3.5 w-3.5" /> Team response
                          {row.admin_replied_at && (
                            <span className="font-normal text-muted-foreground">
                              · {formatDateTime(row.admin_replied_at)}
                            </span>
                          )}
                        </p>
                        <p className="mt-1.5 whitespace-pre-wrap text-sm">{row.admin_reply}</p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </Reveal>
            );
          })}
        </div>
      )}
    </Reveal>
  );
}
