"use client";

import { useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";

import { FadeIn } from "@/components/landing/fade-in";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const TIERS = [
  {
    name: "Free",
    monthly: 0,
    annual: 0,
    tagline: "For trying things out",
    credits: "60 upload minutes / month",
    features: [
      "Up to 3 clips per video",
      "3 caption style presets",
      "ClipForge watermark on clips",
      "Download clips as MP4",
      "Community support",
    ],
    cta: "Start Free",
    highlighted: false,
  },
  {
    name: "Pro",
    monthly: 29,
    annual: 23,
    tagline: "For serious creators",
    credits: "600 upload minutes / month",
    features: [
      "Up to 10 clips per video",
      "All caption styles + logo watermark",
      "No watermark on exports",
      "Multi-platform scheduling",
      "Priority cloud rendering",
      "Email support",
    ],
    cta: "Get Pro",
    highlighted: true,
  },
  {
    name: "Business",
    monthly: 99,
    annual: 79,
    tagline: "For teams & agencies",
    credits: "3,000 upload minutes / month",
    features: [
      "Everything in Pro",
      "5 team seats",
      "API access + webhooks",
      "Custom brand kit presets",
      "Social publishing for all platforms",
      "Dedicated support",
    ],
    cta: "Get Business",
    highlighted: false,
  },
];

export function Pricing() {
  const [annual, setAnnual] = useState(true);

  return (
    <section id="pricing" className="bg-muted/40 py-20 md:py-28">
      <div className="container">
        <FadeIn className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
            Simple pricing that scales with you
          </h2>
          <p className="mt-3 text-muted-foreground">
            Start free. Upgrade when your clips start earning.
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <Label
              htmlFor="billing-toggle"
              className={cn(!annual && "text-foreground")}
            >
              Monthly
            </Label>
            <Switch
              id="billing-toggle"
              checked={annual}
              onCheckedChange={setAnnual}
            />
            <Label
              htmlFor="billing-toggle"
              className={cn("flex items-center gap-2", annual && "text-foreground")}
            >
              Annual
              <Badge className="score-gradient border-transparent text-white">
                Save ~20%
              </Badge>
            </Label>
          </div>
        </FadeIn>

        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {TIERS.map((tier, i) => (
            <FadeIn key={tier.name} delay={i * 0.08}>
              <Card
                className={cn(
                  "relative flex h-full flex-col",
                  tier.highlighted &&
                    "border-primary-500 shadow-lg shadow-primary-500/10 lg:-my-3 lg:py-3"
                )}
              >
                {tier.highlighted && (
                  <Badge className="score-gradient absolute -top-3 left-1/2 -translate-x-1/2 border-transparent text-white">
                    Most Popular
                  </Badge>
                )}
                <CardHeader className="pb-2">
                  <h3 className="text-lg font-semibold">{tier.name}</h3>
                  <p className="text-sm text-muted-foreground">{tier.tagline}</p>
                  <div className="mt-4 flex items-baseline gap-1">
                    <span className="text-4xl font-extrabold tracking-tight">
                      ${annual ? tier.annual : tier.monthly}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      /month{annual && tier.monthly > 0 ? ", billed annually" : ""}
                    </span>
                  </div>
                  <p className="mt-1 text-sm font-medium text-primary-500">
                    {tier.credits}
                  </p>
                </CardHeader>
                <CardContent className="flex-1">
                  <ul className="space-y-2.5 text-sm">
                    {tier.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-2">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary-500" />
                        <span className="text-muted-foreground">{feature}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
                <CardFooter>
                  <Button
                    asChild
                    className="w-full"
                    variant={tier.highlighted ? "default" : "outline"}
                    size="lg"
                  >
                    <Link href="/signup">{tier.cta}</Link>
                  </Button>
                </CardFooter>
              </Card>
            </FadeIn>
          ))}
        </div>
      </div>
    </section>
  );
}
