"use client";

import { useEffect, useState } from "react";
import { Send } from "lucide-react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { formatDateTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

interface FeedbackRow {
  id: string;
  message: string;
  created_at: string;
}

export default function FeedbackPage() {
  const [message, setMessage] = useState("");
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
        .select("id, message, created_at")
        .order("created_at", { ascending: false })
        .limit(20);
      setHistory(data ?? []);
      setHistoryLoaded(true);
    })();
  }, []);

  async function submit() {
    if (!message.trim() || submitting) return;
    setSubmitting(true);
    try {
      await apiFetch("/api/feedback", { method: "POST", body: { message: message.trim() } });
      setHistory((prev) => [
        { id: crypto.randomUUID(), message: message.trim(), created_at: new Date().toISOString() },
        ...prev,
      ]);
      setMessage("");
      toast.success("Thanks — feedback sent!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send feedback");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Feedback</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Anything broken, confusing, or missing? Tell us — it goes straight to the team.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <Textarea
            rows={6}
            placeholder="What's on your mind?"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="flex justify-end">
            <Button onClick={submit} disabled={submitting || !message.trim()}>
              <Send className="h-4 w-4" />
              {submitting ? "Sending…" : "Send feedback"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {historyLoaded && history.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Your previous feedback</h2>
          {history.map((row) => (
            <Card key={row.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-normal text-muted-foreground">
                  {formatDateTime(row.created_at)}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <p className="whitespace-pre-wrap text-sm">{row.message}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
