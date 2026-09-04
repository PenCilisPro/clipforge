"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ExternalLink,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api";
import { isAdminEmail } from "@/lib/admin";
import { createClient } from "@/lib/supabase/client";
import { formatDateTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

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
  created_at: string;
  email: string | null;
  display_name: string | null;
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
  };
}

export default function AdminPage() {
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [feedback, setFeedback] = useState<AdminFeedback[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [planDrafts, setPlanDrafts] = useState<Record<string, PlanDraft>>({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savingPlan, setSavingPlan] = useState<string | null>(null);
  const [creditDrafts, setCreditDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [usersData, feedbackData, pricingData] = await Promise.all([
        apiFetch<{ users: AdminUser[] }>("/api/admin/users"),
        apiFetch<{ feedback: AdminFeedback[] }>("/api/admin/feedback"),
        apiFetch<{ plans: PlanRow[] }>("/api/pricing"),
      ]);
      setUsers(usersData.users);
      setFeedback(feedbackData.feedback);
      setCreditDrafts(
        Object.fromEntries(
          usersData.users.map((u) => [u.id, String(Number(u.credits_remaining))])
        )
      );
      setPlans(pricingData.plans);
      setPlanDrafts(
        Object.fromEntries(pricingData.plans.map((p) => [p.plan_key, planToDraft(p)]))
      );
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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-primary-500" />
          <h1 className="text-2xl font-bold">Admin</h1>
        </div>
        <div className="flex items-center gap-2">
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
          <TabsTrigger value="feedback">
            Feedback
            {feedback.length > 0 && (
              <Badge variant="secondary" className="ml-2">
                {feedback.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
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
          ) : feedback.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
                <MessageSquare className="h-8 w-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No feedback yet — users can send it from the account menu or the
                  Feedback page.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {feedback.map((f) => (
                <Card key={f.id}>
                  <CardContent className="p-4">
                    <p className="whitespace-pre-wrap text-sm">{f.message}</p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {f.display_name ?? "Unknown"} · {f.email ?? f.user_id} ·{" "}
                      {formatDateTime(f.created_at)}
                    </p>
                  </CardContent>
                </Card>
              ))}
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
      </Tabs>
    </div>
  );
}
