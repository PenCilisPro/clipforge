"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ExternalLink,
  Gift,
  ImageIcon,
  Loader2,
  MessageSquare,
  Palette,
  RefreshCw,
  Reply,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api";
import { isAdminEmail } from "@/lib/admin";
import { PLAN_ICON_KEYS, planIcon } from "@/lib/plan-icons";
import { FEEDBACK_CATEGORIES, categoryLabel } from "@/lib/feedback";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { StarRating } from "@/components/dashboard/star-rating";

interface AdminUser {
  id: string;
  email: string | null;
  display_name: string | null;
  plan: string;
  credits_remaining: number | string;
  created_at: string;
  project_count: number;
  clip_count: number;
}

interface AdminFeedback {
  id: string;
  user_id: string;
  message: string;
  category?: string | null;
  rating?: number | null;
  contact_email?: string | null;
  screenshot_path?: string | null;
  admin_reply?: string | null;
  admin_replied_at?: string | null;
  created_at: string;
  email: string | null;
  display_name: string | null;
}

interface UpgradeRequest {
  id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone_country: string;
  phone_number: string;
  header: string;
  plan_use: string;
  other_info: string | null;
  attachment_path: string | null;
  status: "pending" | "approved" | "rejected";
  admin_note: string | null;
  reviewed_at: string | null;
  created_at: string;
  account_email: string | null;
  display_name: string | null;
  account_plan: string | null;
}

interface PlanRow {
  plan_key: string;
  name: string;
  tagline: string;
  monthly_price: number | string;
  annual_price: number | string;
  credits_label: string;
  features: string[] | null;
  cta_label: string;
  highlighted: boolean;
  icon: string;
}

interface PlanDraft {
  name: string;
  tagline: string;
  monthly_price: string;
  annual_price: string;
  credits_label: string;
  featuresText: string;
  cta_label: string;
  highlighted: boolean;
  icon: string;
}

function planToDraft(plan: PlanRow): PlanDraft {
  return {
    name: plan.name,
    tagline: plan.tagline,
    monthly_price: String(Number(plan.monthly_price)),
    annual_price: String(Number(plan.annual_price)),
    credits_label: plan.credits_label,
    featuresText: (plan.features ?? []).join("\n"),
    cta_label: plan.cta_label,
    highlighted: plan.highlighted,
    icon: plan.icon ?? "sparkles",
  };
}

export default function AdminPage() {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [feedback, setFeedback] = useState<AdminFeedback[]>([]);
  const [upgradeRequests, setUpgradeRequests] = useState<UpgradeRequest[]>([]);
  const [reviewNoteDrafts, setReviewNoteDrafts] = useState<Record<string, string>>({});
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [planDrafts, setPlanDrafts] = useState<Record<string, PlanDraft>>({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savingPlan, setSavingPlan] = useState<string | null>(null);
  const [creditDrafts, setCreditDrafts] = useState<Record<string, string>>({});
  const [feedbackFilter, setFeedbackFilter] = useState<string>("all");
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [brandingBusy, setBrandingBusy] = useState(false);
  const brandingInputRef = useRef<HTMLInputElement>(null);
  const [faqDrafts, setFaqDrafts] = useState<{ q: string; a: string }[]>([]);
  const [savingFaq, setSavingFaq] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [usersData, feedbackData, upgradeData, pricingData, brandingData] = await Promise.all([
        apiFetch<{ users: AdminUser[] }>("/api/admin/users"),
        apiFetch<{ feedback: AdminFeedback[] }>("/api/admin/feedback"),
        apiFetch<{ requests: UpgradeRequest[] }>("/api/admin/upgrade-requests"),
        apiFetch<{ plans: PlanRow[] }>("/api/pricing"),
        apiFetch<{ logoUrl: string | null; faq: { q: string; a: string }[] | null }>(
          "/api/branding"
        ),
      ]);
      setUsers(usersData.users);
      setFeedback(feedbackData.feedback);
      setUpgradeRequests(upgradeData.requests);
      setFaqDrafts(brandingData.faq ?? []);
      setCreditDrafts(
        Object.fromEntries(
          usersData.users.map((u) => [u.id, String(Number(u.credits_remaining))])
        )
      );
      setPlans(pricingData.plans);
      setPlanDrafts(
        Object.fromEntries(pricingData.plans.map((p) => [p.plan_key, planToDraft(p)]))
      );
      setLogoUrl(brandingData.logoUrl);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load admin data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      const {
        data: { user },
      } = await createClient().auth.getUser();
      const isAdmin = isAdminEmail(user?.email);
      setAuthorized(isAdmin);
      if (isAdmin) await load();
      else setLoading(false);
    })();
  }, [load]);

  async function saveCredits(u: AdminUser) {
    const credits = Number(creditDrafts[u.id]);
    if (!Number.isFinite(credits) || credits < 0) {
      toast.error("Enter a valid non-negative number");
      return;
    }
    setSavingId(u.id);
    try {
      const { user } = await apiFetch<{ user: AdminUser }>(
        `/api/admin/users/${u.id}/credits`,
        { method: "PATCH", body: { credits } }
      );
      setUsers((prev) => prev.map((row) => (row.id === u.id ? { ...row, ...user } : row)));
      toast.success(`Credits set to ${credits} for ${user.email ?? u.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update credits");
    } finally {
      setSavingId(null);
    }
  }

  async function savePlan(plan: PlanRow) {
    const draft = planDrafts[plan.plan_key];
    if (!draft) return;
    const monthly = Number(draft.monthly_price);
    const annual = Number(draft.annual_price);
    if (!Number.isFinite(monthly) || monthly < 0 || !Number.isFinite(annual) || annual < 0) {
      toast.error("Prices must be non-negative numbers");
      return;
    }
    setSavingPlan(plan.plan_key);
    try {
      const { plan: updated } = await apiFetch<{ plan: PlanRow }>(
        `/api/admin/pricing/${plan.plan_key}`,
        {
          method: "PATCH",
          body: {
            name: draft.name.trim(),
            tagline: draft.tagline.trim(),
            monthly_price: monthly,
            annual_price: annual,
            credits_label: draft.credits_label.trim(),
            features: draft.featuresText
              .split("\n")
              .map((f) => f.trim())
              .filter(Boolean),
            cta_label: draft.cta_label.trim() || "Get started",
            highlighted: draft.highlighted,
            icon: draft.icon,
          },
        }
      );
      setPlans((prev) =>
        prev.map((p) => (p.plan_key === plan.plan_key ? updated : p))
      );
      setPlanDrafts((prev) => ({
        ...prev,
        [plan.plan_key]: planToDraft(updated),
      }));
      toast.success(`"${updated.name}" plan updated — live on the pricing page`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update plan");
    } finally {
      setSavingPlan(null);
    }
  }

  async function sendReply(f: AdminFeedback) {
    const reply = (replyDrafts[f.id] ?? "").trim();
    if (!reply || replyingId) return;
    setReplyingId(f.id);
    try {
      const { feedback: updated } = await apiFetch<{ feedback: AdminFeedback }>(
        `/api/admin/feedback/${f.id}/reply`,
        { method: "PATCH", body: { reply } }
      );
      setFeedback((prev) => prev.map((row) => (row.id === f.id ? { ...row, ...updated } : row)));
      setReplyDrafts((d) => ({ ...d, [f.id]: "" }));
      toast.success("Reply sent — visible on the user's feedback page");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send reply");
    } finally {
      setReplyingId(null);
    }
  }

  async function reviewUpgradeRequest(r: UpgradeRequest, action: "approve" | "reject") {
    if (reviewingId) return;
    setReviewingId(r.id);
    try {
      const { request: updated } = await apiFetch<{ request: UpgradeRequest }>(
        `/api/admin/upgrade-requests/${r.id}/review`,
        {
          method: "PATCH",
          body: {
            action,
            note: (reviewNoteDrafts[r.id] ?? "").trim() || null,
          },
        }
      );
      setUpgradeRequests((prev) =>
        prev.map((row) => (row.id === r.id ? { ...row, ...updated } : row))
      );
      setUsers((prev) =>
        action === "approve"
          ? prev.map((u) => (u.id === r.user_id ? { ...u, plan: "pro" } : u))
          : prev
      );
      toast.success(
        action === "approve"
          ? "Approved — the user is now on the Pro plan"
          : "Request rejected"
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to review request");
    } finally {
      setReviewingId(null);
    }
  }

  async function saveFaq() {
    if (savingFaq) return;
    const cleaned = faqDrafts
      .map((item) => ({ q: item.q.trim(), a: item.a.trim() }))
      .filter((item) => item.q && item.a);
    if (cleaned.length === 0) {
      toast.error("Add at least one complete question and answer");
      return;
    }
    setSavingFaq(true);
    try {
      await apiFetch("/api/admin/faq", { method: "PUT", body: { faqs: cleaned } });
      setFaqDrafts(cleaned);
      toast.success("FAQ saved — live on the landing page");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save FAQ");
    } finally {
      setSavingFaq(false);
    }
  }

  async function uploadBranding(file: File) {
    const okType = /\.(ico|png|svg)$/i.test(file.name);
    if (!okType) {
      toast.error("Choose a .ico, .png or .svg file");
      return;
    }
    if (file.size > 1_000_000) {
      toast.error("Logo must be under 1 MB");
      return;
    }
    setBrandingBusy(true);
    try {
      const data_base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("Could not read file"));
        reader.readAsDataURL(file);
      });
      const { logoUrl: url } = await apiFetch<{ logoUrl: string }>("/api/admin/branding", {
        method: "POST",
        body: { filename: file.name, data_base64 },
      });
      setLogoUrl(url);
      toast.success("Logo updated — applied across the app (favicon may need a refresh)");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to upload logo");
    } finally {
      setBrandingBusy(false);
      if (brandingInputRef.current) brandingInputRef.current.value = "";
    }
  }

  async function resetBranding() {
    if (brandingBusy) return;
    setBrandingBusy(true);
    try {
      await apiFetch("/api/admin/branding", { method: "DELETE" });
      setLogoUrl(null);
      toast.success("Reverted to the default ClipForge logo");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reset logo");
    } finally {
      setBrandingBusy(false);
    }
  }

  if (authorized === false) {
    return (
      <Card className="mx-auto mt-16 max-w-md border-destructive/30">
        <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
          <ShieldAlert className="h-10 w-10 text-destructive" />
          <p className="font-medium">Not authorized</p>
          <p className="text-sm text-muted-foreground">
            This area is restricted to ClipForge admins.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-primary-500" />
          <h1 className="text-2xl font-bold">Admin</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/pricing">
              <ExternalLink className="h-4 w-4" />
              View pricing page
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="upgrades">
            Upgrades
            {upgradeRequests.filter((r) => r.status === "pending").length > 0 && (
              <Badge variant="secondary" className="ml-2">
                {upgradeRequests.filter((r) => r.status === "pending").length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="feedback">
            Feedback
            {feedback.length > 0 && (
              <Badge variant="secondary" className="ml-2">
                {feedback.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
          <TabsTrigger value="faq">FAQ</TabsTrigger>
          <TabsTrigger value="branding">Branding</TabsTrigger>
        </TabsList>

        <TabsContent value="users" className="mt-4">
          {loading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <Card>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-3 font-medium">User</th>
                        <th className="px-4 py-3 font-medium">Plan</th>
                        <th className="px-4 py-3 font-medium">Projects</th>
                        <th className="px-4 py-3 font-medium">Clips</th>
                        <th className="px-4 py-3 font-medium">Credits</th>
                        <th className="px-4 py-3 font-medium">Joined</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((u) => (
                        <tr key={u.id} className="border-b last:border-0">
                          <td className="px-4 py-3">
                            <p className="font-medium">{u.display_name ?? "—"}</p>
                            <p className="text-xs text-muted-foreground">{u.email ?? u.id}</p>
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant="secondary" className="capitalize">
                              {u.plan}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 tabular-nums">{u.project_count}</td>
                          <td className="px-4 py-3 tabular-nums">{u.clip_count}</td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <Input
                                type="number"
                                min={0}
                                className="h-8 w-24"
                                value={creditDrafts[u.id] ?? ""}
                                onChange={(e) =>
                                  setCreditDrafts((d) => ({ ...d, [u.id]: e.target.value }))
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") saveCredits(u);
                                }}
                              />
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8"
                                disabled={savingId === u.id}
                                onClick={() => saveCredits(u)}
                              >
                                {savingId === u.id ? "Saving…" : "Set"}
                              </Button>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {formatDateTime(u.created_at)}
                          </td>
                        </tr>
                      ))}
                      {users.length === 0 && (
                        <tr>
                          <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                            No users yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="feedback" className="mt-4">
          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground">Filter</Label>
                <Select value={feedbackFilter} onValueChange={setFeedbackFilter}>
                  <SelectTrigger className="h-8 w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All feedback</SelectItem>
                    {FEEDBACK_CATEGORIES.map((c) => (
                      <SelectItem key={c.value} value={c.value}>
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">
                  {
                    feedback.filter(
                      (f) => feedbackFilter === "all" || f.category === feedbackFilter
                    ).length
                  }{" "}
                  shown
                </span>
              </div>
              {feedback.filter(
                (f) => feedbackFilter === "all" || f.category === feedbackFilter
              ).length === 0 ? (
                <Card>
                  <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
                    <MessageSquare className="h-8 w-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      No feedback in this category yet.
                    </p>
                  </CardContent>
                </Card>
              ) : (
                feedback
                  .filter((f) => feedbackFilter === "all" || f.category === feedbackFilter)
                  .map((f) => {
                    const supabase = createClient();
                    const screenshotUrl = f.screenshot_path
                      ? supabase.storage.from("assets").getPublicUrl(f.screenshot_path).data.publicUrl
                      : null;
                    return (
                      <Card key={f.id}>
                        <CardContent className="p-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge
                              variant={
                                f.category === "bug_report"
                                  ? "destructive"
                                  : f.category === "billing"
                                    ? "default"
                                    : "secondary"
                              }
                            >
                              {categoryLabel(f.category)}
                            </Badge>
                            {f.rating != null && <StarRating value={f.rating} size="sm" />}
                            <span className="ml-auto text-xs text-muted-foreground">
                              {formatDateTime(f.created_at)}
                            </span>
                          </div>
                          <p className="mt-2 whitespace-pre-wrap text-sm">{f.message}</p>
                          {screenshotUrl && (
                            <a href={screenshotUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={screenshotUrl}
                                alt="User screenshot"
                                className="max-h-36 rounded-lg border object-cover"
                              />
                            </a>
                          )}
                          <p className="mt-2 text-xs text-muted-foreground">
                            {f.display_name ?? "Unknown"} · {f.email ?? f.user_id}
                            {f.contact_email && f.contact_email !== f.email && (
                              <span> · replied-to: {f.contact_email}</span>
                            )}
                          </p>

                          {f.admin_reply ? (
                            <div className="mt-3 rounded-lg border-l-2 border-primary-500 bg-primary-500/5 p-3">
                              <p className="text-xs font-semibold text-primary-600 dark:text-primary-400">
                                Your reply
                                {f.admin_replied_at && (
                                  <span className="font-normal text-muted-foreground">
                                    {" "}· {formatDateTime(f.admin_replied_at)}
                                  </span>
                                )}
                              </p>
                              <p className="mt-1.5 whitespace-pre-wrap text-sm">{f.admin_reply}</p>
                            </div>
                          ) : (
                            <div className="mt-3 flex items-end gap-2">
                              <Textarea
                                rows={2}
                                placeholder="Reply to this user…"
                                value={replyDrafts[f.id] ?? ""}
                                onChange={(e) =>
                                  setReplyDrafts((d) => ({ ...d, [f.id]: e.target.value }))
                                }
                              />
                              <Button
                                size="sm"
                                disabled={replyingId === f.id || !(replyDrafts[f.id] ?? "").trim()}
                                onClick={() => sendReply(f)}
                              >
                                {replyingId === f.id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Reply className="h-4 w-4" />
                                )}
                                Reply
                              </Button>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="upgrades" className="mt-4">
          {loading ? (
            <div className="space-y-3">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : upgradeRequests.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
                <Gift className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No free-upgrade requests yet.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {upgradeRequests.map((r) => {
                const supabase = createClient();
                const attachmentUrl = r.attachment_path
                  ? supabase.storage.from("assets").getPublicUrl(r.attachment_path).data.publicUrl
                  : null;
                const isMedia = /\.(mp4|mov|webm)$/i.test(r.attachment_path ?? "");
                return (
                  <Card key={r.id}>
                    <CardContent className="p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant={
                            r.status === "approved"
                              ? "default"
                              : r.status === "rejected"
                                ? "destructive"
                                : "secondary"
                          }
                          className="capitalize"
                        >
                          {r.status}
                        </Badge>
                        <p className="font-medium">{r.header}</p>
                        <span className="ml-auto text-xs text-muted-foreground">
                          {formatDateTime(r.created_at)}
                          {r.reviewed_at && ` · reviewed ${formatDateTime(r.reviewed_at)}`}
                        </span>
                      </div>

                      <div className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                        <p>
                          <span className="text-muted-foreground">Name:</span>{" "}
                          {r.first_name} {r.last_name}
                        </p>
                        <p>
                          <span className="text-muted-foreground">Email:</span> {r.email}
                        </p>
                        <p>
                          <span className="text-muted-foreground">Phone:</span>{" "}
                          {r.phone_country} {r.phone_number}
                        </p>
                        <p>
                          <span className="text-muted-foreground">Account:</span>{" "}
                          {r.display_name ?? "—"} · {r.account_email ?? r.user_id} ·{" "}
                          <span className="capitalize">{r.account_plan ?? "?"}</span>
                        </p>
                      </div>

                      <div className="mt-3 space-y-2 text-sm">
                        <p>
                          <span className="text-muted-foreground">Plan use:</span>{" "}
                          <span className="whitespace-pre-wrap">{r.plan_use}</span>
                        </p>
                        {r.other_info && (
                          <p>
                            <span className="text-muted-foreground">Other info:</span>{" "}
                            <span className="whitespace-pre-wrap">{r.other_info}</span>
                          </p>
                        )}
                      </div>

                      {attachmentUrl && (
                        <a
                          href={attachmentUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-2 inline-block"
                        >
                          {isMedia ? (
                            <span className="text-xs underline">View attached video</span>
                          ) : (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={attachmentUrl}
                              alt="User attachment"
                              className="max-h-36 rounded-lg border object-cover"
                            />
                          )}
                        </a>
                      )}

                      {r.status === "pending" ? (
                        <div className="mt-3 space-y-2">
                          <Textarea
                            rows={2}
                            placeholder="Optional note for the user (shown on their requests)…"
                            value={reviewNoteDrafts[r.id] ?? ""}
                            onChange={(e) =>
                              setReviewNoteDrafts((d) => ({ ...d, [r.id]: e.target.value }))
                            }
                          />
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-destructive"
                              disabled={reviewingId === r.id}
                              onClick={() => reviewUpgradeRequest(r, "reject")}
                            >
                              {reviewingId === r.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                "Reject"
                              )}
                            </Button>
                            <Button
                              size="sm"
                              disabled={reviewingId === r.id}
                              onClick={() => reviewUpgradeRequest(r, "approve")}
                            >
                              {reviewingId === r.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Gift className="h-4 w-4" />
                              )}
                              Approve → Pro
                            </Button>
                          </div>
                        </div>
                      ) : (
                        r.admin_note && (
                          <p className="mt-3 rounded-lg border-l-2 border-primary-500 bg-primary-500/5 p-3 text-sm">
                            <span className="text-xs font-semibold text-primary-600 dark:text-primary-400">
                              Note:
                            </span>{" "}
                            {r.admin_note}
                          </p>
                        )
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="pricing" className="mt-4">
          {loading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Changes here update the public pricing page immediately. "Features"
                are the plan's privileges — one per line.
              </p>
              {plans.map((plan) => {
                const draft = planDrafts[plan.plan_key];
                if (!draft) return null;
                return (
                  <Card key={plan.plan_key}>
                    <CardContent className="space-y-4 p-4">
                      <div className="flex items-center justify-between">
                        <Badge variant="outline" className="font-mono text-xs">
                          {plan.plan_key}
                        </Badge>
                        <div className="flex items-center gap-2">
                          <Label
                            htmlFor={`hl-${plan.plan_key}`}
                            className="text-xs text-muted-foreground"
                          >
                            Most popular
                          </Label>
                          <Switch
                            id={`hl-${plan.plan_key}`}
                            checked={draft.highlighted}
                            onCheckedChange={(checked) =>
                              setPlanDrafts((d) => ({
                                ...d,
                                [plan.plan_key]: { ...d[plan.plan_key], highlighted: checked },
                              }))
                            }
                          />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label className="text-xs">Plan icon</Label>
                        <div className="flex flex-wrap gap-1.5">
                          {PLAN_ICON_KEYS.map((key) => {
                            const Icon = planIcon(key);
                            const selected = draft.icon === key;
                            return (
                              <button
                                key={key}
                                type="button"
                                title={key}
                                aria-label={`Icon: ${key}`}
                                className={
                                  selected
                                    ? "flex h-9 w-9 items-center justify-center rounded-lg border border-primary-500 bg-primary-500/10 text-primary-600 dark:text-primary-400"
                                    : "flex h-9 w-9 items-center justify-center rounded-lg border text-muted-foreground transition-colors hover:border-primary-500/50 hover:text-foreground"
                                }
                                onClick={() =>
                                  setPlanDrafts((d) => ({
                                    ...d,
                                    [plan.plan_key]: { ...d[plan.plan_key], icon: key },
                                  }))
                                }
                              >
                                <Icon className="h-4 w-4" />
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-1.5">
                          <Label className="text-xs">Plan name</Label>
                          <Input
                            value={draft.name}
                            onChange={(e) =>
                              setPlanDrafts((d) => ({
                                ...d,
                                [plan.plan_key]: { ...d[plan.plan_key], name: e.target.value },
                              }))
                            }
                          />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Tagline</Label>
                          <Input
                            value={draft.tagline}
                            onChange={(e) =>
                              setPlanDrafts((d) => ({
                                ...d,
                                [plan.plan_key]: { ...d[plan.plan_key], tagline: e.target.value },
                              }))
                            }
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1.5">
                            <Label className="text-xs">Monthly price ($)</Label>
                            <Input
                              type="number"
                              min={0}
                              value={draft.monthly_price}
                              onChange={(e) =>
                                setPlanDrafts((d) => ({
                                  ...d,
                                  [plan.plan_key]: {
                                    ...d[plan.plan_key],
                                    monthly_price: e.target.value,
                                  },
                                }))
                              }
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs">Annual price ($/mo)</Label>
                            <Input
                              type="number"
                              min={0}
                              value={draft.annual_price}
                              onChange={(e) =>
                                setPlanDrafts((d) => ({
                                  ...d,
                                  [plan.plan_key]: {
                                    ...d[plan.plan_key],
                                    annual_price: e.target.value,
                                  },
                                }))
                              }
                            />
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Credits label</Label>
                          <Input
                            value={draft.credits_label}
                            placeholder="e.g. 600 upload minutes / month"
                            onChange={(e) =>
                              setPlanDrafts((d) => ({
                                ...d,
                                [plan.plan_key]: {
                                  ...d[plan.plan_key],
                                  credits_label: e.target.value,
                                },
                              }))
                            }
                          />
                        </div>
                        <div className="space-y-1.5 md:col-span-2">
                          <Label className="text-xs">
                            Features / privileges (one per line)
                          </Label>
                          <Textarea
                            rows={5}
                            value={draft.featuresText}
                            onChange={(e) =>
                              setPlanDrafts((d) => ({
                                ...d,
                                [plan.plan_key]: {
                                  ...d[plan.plan_key],
                                  featuresText: e.target.value,
                                },
                              }))
                            }
                          />
                        </div>
                        <div className="space-y-1.5 md:col-span-2 md:max-w-xs">
                          <Label className="text-xs">Button label</Label>
                          <Input
                            value={draft.cta_label}
                            onChange={(e) =>
                              setPlanDrafts((d) => ({
                                ...d,
                                [plan.plan_key]: { ...d[plan.plan_key], cta_label: e.target.value },
                              }))
                            }
                          />
                        </div>
                      </div>

                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          disabled={savingPlan === plan.plan_key}
                          onClick={() => savePlan(plan)}
                        >
                          {savingPlan === plan.plan_key ? "Saving…" : "Save plan"}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>
        <TabsContent value="faq" className="mt-4">
          {loading ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <div className="max-w-3xl space-y-4">
              <p className="text-sm text-muted-foreground">
                Questions and answers shown in the landing page FAQ section.
                Saving replaces the whole list.
              </p>
              {faqDrafts.map((item, i) => (
                <Card key={i}>
                  <CardContent className="space-y-2 p-4">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">#{i + 1}</span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="ml-auto h-7 w-7 text-destructive"
                        aria-label="Remove question"
                        onClick={() =>
                          setFaqDrafts((d) => d.filter((_, index) => index !== i))
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    <Input
                      placeholder="Question"
                      value={item.q}
                      onChange={(e) =>
                        setFaqDrafts((d) =>
                          d.map((row, index) =>
                            index === i ? { ...row, q: e.target.value } : row
                          )
                        )
                      }
                    />
                    <Textarea
                      rows={3}
                      placeholder="Answer"
                      value={item.a}
                      onChange={(e) =>
                        setFaqDrafts((d) =>
                          d.map((row, index) =>
                            index === i ? { ...row, a: e.target.value } : row
                          )
                        )
                      }
                    />
                  </CardContent>
                </Card>
              ))}
              <div className="flex items-center justify-between">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setFaqDrafts((d) => [...d, { q: "", a: "" }])}
                >
                  + Add question
                </Button>
                <Button size="sm" disabled={savingFaq} onClick={saveFaq}>
                  {savingFaq ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    "Save FAQ"
                  )}
                </Button>
              </div>
            </div>
          )}
        </TabsContent>
        <TabsContent value="branding" className="mt-4">
          {loading ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <Card className="max-w-xl">
              <CardContent className="space-y-4 p-4">
                <div className="flex items-center gap-2">
                  <Palette className="h-4 w-4 text-primary-500" />
                  <p className="text-sm font-semibold">App logo & favicon</p>
                </div>
                <p className="text-sm text-muted-foreground">
                  Upload a .ico, .png or .svg (under 1 MB). It replaces the
                  orange bolt across every page — sidebar, landing, auth — and
                  becomes the browser tab icon.
                </p>
                <div className="flex items-center gap-4">
                  <div className="flex h-16 w-16 items-center justify-center rounded-xl border bg-muted/40">
                    {logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={logoUrl}
                        alt="Current logo"
                        className="h-12 w-12 rounded-lg object-contain"
                      />
                    ) : (
                      <ImageIcon className="h-6 w-6 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={brandingBusy}
                      onClick={() => brandingInputRef.current?.click()}
                    >
                      {brandingBusy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4" />
                      )}
                      {logoUrl ? "Replace logo" : "Upload logo"}
                    </Button>
                    {logoUrl && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={brandingBusy}
                        onClick={resetBranding}
                      >
                        <Trash2 /> Reset to default
                      </Button>
                    )}
                  </div>
                  <input
                    ref={brandingInputRef}
                    type="file"
                    accept=".ico,.png,.svg,image/x-icon,image/png,image/svg+xml"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) uploadBranding(file);
                    }}
                  />
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
