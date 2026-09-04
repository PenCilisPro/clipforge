"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Cookie } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const STORAGE_KEY = "cf-cookie-consent";

/** Bottom-left cookie consent banner, shown on every page until answered. */
export function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(STORAGE_KEY)) setVisible(true);
    } catch {
      // storage unavailable (private mode) — don't nag
    }
  }, []);

  function decide(choice: "accepted" | "declined") {
    try {
      localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // ignore
    }
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <Card className="animate-fade-up fixed bottom-4 left-4 z-50 w-[calc(100vw-2rem)] max-w-sm border bg-background/95 shadow-xl backdrop-blur">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Cookie className="h-4 w-4 text-primary-500" />
          We use cookies
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          ClipForge uses essential cookies to keep you signed in, plus optional
          analytics to improve the product. See our{" "}
          <Link href="/privacy" className="underline hover:text-foreground">
            Privacy Policy
          </Link>{" "}
          and{" "}
          <Link href="/terms" className="underline hover:text-foreground">
            Terms of Service
          </Link>
          .
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => decide("accepted")}>
            Accept all
          </Button>
          <Button size="sm" variant="outline" onClick={() => decide("declined")}>
            Essential only
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
