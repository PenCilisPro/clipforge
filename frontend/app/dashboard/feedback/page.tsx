"use client";

import { useEffect, useState } from "react";
import { Send } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

interface FeedbackRow {
  id: string;
  message: string;
  category?: string;
  rating?: number | null;
  created_at: string;
}

export default function FeedbackPage() {
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState<FeedbackCategory>("general");
  const [rating, setRating] = useState<number | null>(null);
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
        .select("id, message, category, rating, created_at")
        .order("created_at", { ascending: false })
        .limit(20);
      setHistory((data as FeedbackRow[]) ?? []);
      setHistoryLoaded(true);
    })();
  }, []);

  async function submit() {
    if (!message.trim() || !rating || submitting) return;
    setSubmitting(true);
    try {
      await apiFetch("/api/feedback", {
        method: "POST",
        body: { message: message.trim(), category, rating },
      });
      setHistory((prev) => [
        {
          id: crypto.randomUUID(),
          message: message.trim(),
          category,
          rating,
          created_at: new Date().toISOString(),
        },
        ...prev,
      ]);
      setMessage("");
      setRating(null);
      setCategory("general");
      toast.success("Thanks — feedback sent!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send feedback");
    } finally {
      setSubmitting(false);
    }
  }

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
          <div className="flex justify-end">
            <Button onClick={submit} disabled={submitting || !message.trim() || !rating}>
              <Send className="h-4 w-4" />
              {submitting ? "Sending…" : "Send feedback"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {historyLoaded && history.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Your previous feedback</h2>
          {history.map((row, i) => (
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
                </CardContent>
              </Card>
            </Reveal>
          ))}
        </div>
      )}
    </Reveal>
  );
}
