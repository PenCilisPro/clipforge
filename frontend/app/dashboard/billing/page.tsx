"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BadgeCheck, Check, Zap } from "lucide-react";
import { toast } from "sonner";

import { apiFetch } from "@/lib/api";
import { planIcon } from "@/lib/plan-icons";
import { Reveal } from "@/components/dashboard/reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface Profile {
  plan: string;
  credits_remaining: number | string;
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

export default function BillingPage() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [me, pricing] = await Promise.all([
          apiFetch<{ profile: Profile }>("/api/me"),
          apiFetch<{ plans: PlanRow[] }>("/api/pricing"),
        ]);
        setProfile(me.profile);
        setPlans(pricing.plans);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load billing info");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function requestUpgrade(plan: PlanRow) {
    if (requesting) return;
    setRequesting(plan.plan_key);
    try {
      await apiFetch("/api/feedback", {
        method: "POST",
        body: {
          category: "billing",
          rating: null,
          message: `Upgrade request: please move my account to the "${plan.name}" plan.`,
        },
      });
      toast.success(
        `Request sent — the team has been notified about "${plan.name}" and will apply it.`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send request");
    } finally {
      setRequesting(null);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const currentPlan = plans.find((p) => p.plan_key === profile?.plan);
  const credits = Number(profile?.credits_remaining ?? 0);

  return (
    <Reveal className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your plan and remaining credits.
        </p>
      </div>

      <Card className="border-primary-500/40 bg-primary-500/5">
        <CardContent className="flex flex-wrap items-center gap-6 p-5">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary-500/10">
            {currentPlan ? (
              (() => {
                const Icon = planIcon(currentPlan.icon);
                return <Icon className="h-6 w-6 text-primary-500" />;
              })()
            ) : (
              <Zap className="h-6 w-6 text-primary-500" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="text-lg font-semibold">
                {currentPlan?.name ?? (profile?.plan || "free") + " plan"}
              </p>
              <Badge variant="secondary" className="capitalize">
                current
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {currentPlan?.credits_label || "Your plan's credits"}
            </p>
          </div>
          <div className="ml-auto text-right">
            <p className="text-3xl font-extrabold tracking-tight">{credits}</p>
            <p className="text-xs text-muted-foreground">credits left</p>
          </div>
        </CardContent>
      </Card>

      <div>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">Available plans</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {plans.map((plan, i) => {
            const Icon = planIcon(plan.icon);
            const isCurrent = plan.plan_key === profile?.plan;
            return (
              <Reveal key={plan.plan_key} delay={i * 0.06} className="h-full">
                <Card
                  className={
                    isCurrent
                      ? "h-full border-primary-500"
                      : "h-full transition-all hover:-translate-y-1 hover:shadow-md"
                  }
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-500/10">
                        <Icon className="h-5 w-5 text-primary-500" />
                      </div>
                      {isCurrent && (
                        <Badge variant="secondary" className="gap-1">
                          <BadgeCheck className="h-3 w-3" /> Current
                        </Badge>
                      )}
                    </div>
                    <CardTitle className="mt-2 text-base">{plan.name}</CardTitle>
                    <p className="text-xs text-muted-foreground">{plan.tagline}</p>
                    <div className="mt-2 flex items-baseline gap-1">
                      <span className="text-2xl font-extrabold">
                        ${Number(plan.annual_price)}
                      </span>
                      <span className="text-xs text-muted-foreground">/month</span>
                    </div>
                  </CardHeader>
                  <CardContent className="flex h-full flex-col justify-between gap-3">
                    <ul className="space-y-1.5 text-xs">
                      {(plan.features ?? []).slice(0, 4).map((feature) => (
                        <li key={feature} className="flex items-start gap-1.5">
                          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary-500" />
                          <span className="text-muted-foreground">{feature}</span>
                        </li>
                      ))}
                    </ul>
                    <Button
                      size="sm"
                      variant={isCurrent ? "secondary" : "outline"}
                      disabled={isCurrent || requesting === plan.plan_key}
                      onClick={() => requestUpgrade(plan)}
                      className="w-full"
                    >
                      {isCurrent
                        ? "Your plan"
                        : requesting === plan.plan_key
                          ? "Sending…"
                          : "Request upgrade"}
                    </Button>
                  </CardContent>
                </Card>
              </Reveal>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Upgrades are processed by the ClipForge team — hit "Request upgrade"
          (it sends us a billing request) and we'll apply it to your account. You
          can also{" "}
          <Link href="/dashboard/upgrade" className="underline">
            apply for a free upgrade
          </Link>{" "}
          by telling us what you're building.
        </p>
      </div>
    </Reveal>
  );
}
