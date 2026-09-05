"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { BadgeCheck, Clock, Loader2, Paperclip, Send, X } from "lucide-react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { formatDateTime } from "@/lib/utils";
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
import { Reveal } from "@/components/dashboard/reveal";

const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024; // 40 MB

// Calling code → country label shown in the phone selector.
const PHONE_COUNTRIES: { code: string; label: string }[] = [
  { code: "+1", label: "USA / Canada" },
  { code: "+66", label: "Thailand" },
  { code: "+44", label: "United Kingdom" },
  { code: "+61", label: "Australia" },
  { code: "+81", label: "Japan" },
  { code: "+82", label: "South Korea" },
  { code: "+86", label: "China" },
  { code: "+852", label: "Hong Kong" },
  { code: "+886", label: "Taiwan" },
  { code: "+65", label: "Singapore" },
  { code: "+60", label: "Malaysia" },
  { code: "+62", label: "Indonesia" },
  { code: "+63", label: "Philippines" },
  { code: "+84", label: "Vietnam" },
  { code: "+91", label: "India" },
  { code: "+92", label: "Pakistan" },
  { code: "+880", label: "Bangladesh" },
  { code: "+94", label: "Sri Lanka" },
  { code: "+95", label: "Myanmar" },
  { code: "+855", label: "Cambodia" },
  { code: "+856", label: "Laos" },
  { code: "+7", label: "Russia / Kazakhstan" },
  { code: "+971", label: "UAE" },
  { code: "+966", label: "Saudi Arabia" },
  { code: "+974", label: "Qatar" },
  { code: "+973", label: "Bahrain" },
  { code: "+968", label: "Oman" },
  { code: "+962", label: "Jordan" },
  { code: "+961", label: "Lebanon" },
  { code: "+964", label: "Iraq" },
  { code: "+98", label: "Iran" },
  { code: "+972", label: "Israel" },
  { code: "+90", label: "Turkey" },
  { code: "+49", label: "Germany" },
  { code: "+33", label: "France" },
  { code: "+31", label: "Netherlands" },
  { code: "+34", label: "Spain" },
  { code: "+39", label: "Italy" },
  { code: "+41", label: "Switzerland" },
  { code: "+43", label: "Austria" },
  { code: "+48", label: "Poland" },
  { code: "+45", label: "Denmark" },
  { code: "+46", label: "Sweden" },
  { code: "+47", label: "Norway" },
  { code: "+358", label: "Finland" },
  { code: "+353", label: "Ireland" },
  { code: "+20", label: "Egypt" },
  { code: "+27", label: "South Africa" },
  { code: "+234", label: "Nigeria" },
  { code: "+254", label: "Kenya" },
  { code: "+52", label: "Mexico" },
  { code: "+55", label: "Brazil" },
  { code: "+54", label: "Argentina" },
  { code: "+56", label: "Chile" },
  { code: "+57", label: "Colombia" },
  { code: "+51", label: "Peru" },
  { code: "+58", label: "Venezuela" },
];

interface UpgradeRequestRow {
  id: string;
  status: "pending" | "approved" | "rejected";
  admin_note: string | null;
  reviewed_at: string | null;
  created_at: string;
}

const STATUS_BADGE: Record<
  UpgradeRequestRow["status"],
  "default" | "secondary" | "destructive"
> = {
  pending: "secondary",
  approved: "default",
  rejected: "destructive",
};

export default function UpgradeRequestPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phoneCountry, setPhoneCountry] = useState("+1");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [header, setHeader] = useState("");
  const [planUse, setPlanUse] = useState("");
  const [otherInfo, setOtherInfo] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [history, setHistory] = useState<UpgradeRequestRow[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user?.email) setEmail(user.email);
      try {
        const { requests } = await apiFetch<{ requests: UpgradeRequestRow[] }>(
          "/api/upgrade-requests"
        );
        setHistory(requests);
      } catch {
        // Non-fatal — the form is still usable.
      } finally {
        setHistoryLoaded(true);
      }
    })();
  }, []);

  function pickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    if (!selected) return;
    if (!selected.type.startsWith("image/") && !selected.type.startsWith("video/")) {
      toast.error("Attach an image or a video");
      return;
    }
    if (selected.size > MAX_ATTACHMENT_BYTES) {
      toast.error("File must be under 40 MB");
      return;
    }
    setFile(selected);
  }

  function clearFile() {
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      let attachmentPath: string | null = null;
      const supabase = createClient();

      if (file) {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) throw new Error("Not signed in");
        const ext = (file.name.split(".").pop() ?? "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
        attachmentPath = `${user.id}/upgrade-${Date.now()}.${ext}`;
        const { error: uploadError } = await supabase.storage
          .from("assets")
          .upload(attachmentPath, file, { contentType: file.type, upsert: false });
        if (uploadError) throw uploadError;
      }

      await apiFetch("/api/upgrade-requests", {
        method: "POST",
        body: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim(),
          phone_country: phoneCountry,
          phone_number: phoneNumber.trim(),
          header: header.trim(),
          plan_use: planUse.trim(),
          other_info: otherInfo.trim() || null,
          attachment_path: attachmentPath,
        },
      });
      toast.success("Request submitted — we'll get back to you soon!");
      setHeader("");
      setPlanUse("");
      setOtherInfo("");
      setPhoneNumber("");
      clearFile();
      const { requests } = await apiFetch<{ requests: UpgradeRequestRow[] }>(
        "/api/upgrade-requests"
      );
      setHistory(requests);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to submit request");
    } finally {
      setSubmitting(false);
    }
  }

  const pending = history.find((r) => r.status === "pending");

  return (
    <Reveal className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Request a free upgrade</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tell us what you're building and why Pro would help — approved
          requests get a complimentary subscription.
        </p>
      </div>

      {historyLoaded && history.some((r) => r.status === "approved") && (
        <Card className="border-emerald-500/40">
          <CardContent className="flex items-center gap-3 p-4">
            <BadgeCheck className="h-5 w-5 text-emerald-500" />
            <p className="text-sm">
              Your upgrade was approved — Pro features are already unlocked.
            </p>
          </CardContent>
        </Card>
      )}

      {pending && (
        <Card>
          <CardContent className="flex items-center gap-3 p-4">
            <Clock className="h-5 w-5 text-amber-500" />
            <p className="text-sm">
              A request is already being reviewed
              {pending.reviewed_at ? "" : ` (submitted ${formatDateTime(pending.created_at)})`}.
              You can submit a new one once it's reviewed.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-4">
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">First name *</Label>
                <Input
                  required
                  maxLength={100}
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  disabled={!!pending}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Last name *</Label>
                <Input
                  required
                  maxLength={100}
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  disabled={!!pending}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Email *</Label>
                <Input
                  required
                  type="email"
                  maxLength={200}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={!!pending}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Phone number *</Label>
                <div className="flex gap-2">
                  <Select
                    value={phoneCountry}
                    onValueChange={setPhoneCountry}
                    disabled={!!pending}
                  >
                    <SelectTrigger className="w-36 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PHONE_COUNTRIES.map((c) => (
                        <SelectItem key={c.code} value={c.code}>
                          {c.code} · {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    required
                    inputMode="tel"
                    pattern="[0-9 ()-]{4,20}"
                    placeholder="812 345 6789"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    disabled={!!pending}
                  />
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Header *</Label>
              <Input
                required
                maxLength={200}
                placeholder="e.g. Student creator launching a cooking channel"
                value={header}
                onChange={(e) => setHeader(e.target.value)}
                disabled={!!pending}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">
                Tell us what you're planning to do with this subscription *
              </Label>
              <Textarea
                required
                rows={5}
                maxLength={4000}
                placeholder="What content will you create? Where will you publish? How would Pro help?"
                value={planUse}
                onChange={(e) => setPlanUse(e.target.value)}
                disabled={!!pending}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Other info (optional)</Label>
              <Textarea
                rows={3}
                maxLength={4000}
                placeholder="Anything else that helps us decide — links, audience size, timeline…"
                value={otherInfo}
                onChange={(e) => setOtherInfo(e.target.value)}
                disabled={!!pending}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Image or video (optional, &lt; 40 MB)</Label>
              {file ? (
                <div className="flex items-center gap-2 rounded-lg border p-2">
                  <Paperclip className="h-4 w-4 text-muted-foreground" />
                  <p className="min-w-0 flex-1 truncate text-xs">{file.name}</p>
                  <Button
                    size="icon"
                    variant="ghost"
                    type="button"
                    className="h-7 w-7"
                    aria-label="Remove attachment"
                    onClick={clearFile}
                    disabled={!!pending}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!!pending}
                >
                  <Paperclip /> Attach image or video
                </Button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/*"
                className="hidden"
                onChange={pickFile}
              />
            </div>

            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Every request is reviewed by our team.{" "}
                <Link href="/pricing" className="underline">
                  Compare plans
                </Link>
              </p>
              <Button type="submit" disabled={submitting || !!pending}>
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {submitting ? "Submitting…" : "Submit request"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {historyLoaded && history.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Your requests</h2>
          {history.map((row) => (
            <Card key={row.id}>
              <CardContent className="flex flex-wrap items-center gap-2 p-3">
                <Badge variant={STATUS_BADGE[row.status]} className="capitalize">
                  {row.status}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  submitted {formatDateTime(row.created_at)}
                  {row.reviewed_at && ` · reviewed ${formatDateTime(row.reviewed_at)}`}
                </span>
                {row.admin_note && (
                  <p className="w-full text-sm text-muted-foreground">{row.admin_note}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </Reveal>
  );
}
