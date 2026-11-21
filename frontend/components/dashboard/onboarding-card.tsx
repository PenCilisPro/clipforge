"use client";

/**
 * First-run onboarding: a 3-step checklist shown on Home until the user has
 * a finished project (or dismisses it). Steps check off from real app state —
 * no fake progress — and a brand-colored confetti burst fires when the
 * pipeline completes for the first time.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import confetti from "canvas-confetti";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Circle, PartyPopper, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface OnboardingStep {
  key: string;
  label: string;
  done: boolean;
}

const BRAND_COLORS = ["#FF5D1C", "#FF8A50", "#FFB37E", "#FFC9A3"];

function fireConfetti() {
  const end = Date.now() + 1200;
  const frame = () => {
    void confetti({
      particleCount: 4,
      angle: 60,
      spread: 60,
      origin: { x: 0, y: 0.7 },
      colors: BRAND_COLORS,
    });
    void confetti({
      particleCount: 4,
      angle: 120,
      spread: 60,
      origin: { x: 1, y: 0.7 },
      colors: BRAND_COLORS,
    });
    if (Date.now() < end) requestAnimationFrame(frame);
  };
  frame();
}

export function OnboardingCard({
  steps,
  active,
  onDismiss,
  onPasteLink,
  onOpenProject,
  newestProjectId,
}: {
  steps: OnboardingStep[];
  /** Card is rendered while true (parent owns visibility state). */
  active: boolean;
  onDismiss: () => void;
  /** Focuses the Home URL input — step 1's CTA. */
  onPasteLink: () => void;
  /** Fired when the final CTA navigates to the finished project. */
  onOpenProject?: () => void;
  /** Newest project to open once the pipeline has run. */
  newestProjectId: string | null;
}) {
  const firedRef = useRef(false);
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const allDone = steps.every((s) => s.done);

  // Celebrate the moment the pipeline first completes for this user.
  const pipelineDone = steps.find((s) => s.key === "pipeline")?.done ?? false;
  useEffect(() => {
    if (pipelineDone && !firedRef.current) {
      firedRef.current = true;
      fireConfetti();
    }
    if (!pipelineDone) firedRef.current = false;
  }, [pipelineDone]);

  // Resolve the project to open once one exists.
  useEffect(() => {
    if (newestProjectId) setOpenProjectId(newestProjectId);
  }, [newestProjectId]);

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.3 }}
          className="relative rounded-2xl border border-primary-500/40 bg-gradient-to-br from-primary-500/[0.08] via-card to-card p-5 shadow-lg shadow-primary-500/5"
        >
          <button
            type="button"
            aria-label="Dismiss onboarding"
            onClick={onDismiss}
            className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>

          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary-500/15">
              <PartyPopper className="h-4.5 w-4.5 text-primary-500" />
            </span>
            <div>
              <h2 className="text-sm font-semibold">
                {allDone ? "You're all set 🎉" : "Welcome to ClipForge"}
              </h2>
              <p className="text-xs text-muted-foreground">
                {allDone
                  ? "Your first clips are rendered — schedule or download them anytime."
                  : "Three steps to your first viral clips."}
              </p>
            </div>
          </div>

          <ol className="mt-4 space-y-3">
            {steps.map((step, i) => (
              <li key={step.key} className="flex items-start gap-3">
                <span
                  className={cn(
                    "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition-colors",
                    step.done
                      ? "border-primary-500 bg-primary-500 text-white"
                      : "border-border text-muted-foreground"
                  )}
                  aria-label={step.done ? "Completed" : `Step ${i + 1} pending`}
                >
                  {step.done ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Circle className="h-2 w-2 rounded-full fill-current" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "text-sm font-medium",
                      step.done && "text-muted-foreground line-through"
                    )}
                  >
                    {step.label}
                  </p>
                  {i === 0 && !step.done && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 h-7 border-primary-500/50 text-xs text-primary-600 hover:bg-primary-500/10 dark:text-primary-400"
                      onClick={onPasteLink}
                    >
                      Paste a link now
                    </Button>
                  )}
                  {i === 2 && step.done && openProjectId && (
                    <Button asChild size="sm" className="mt-2 h-7 text-xs" onClick={onOpenProject}>
                      <Link href={`/dashboard/projects/${openProjectId}`}>
                        Open my project
                      </Link>
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
