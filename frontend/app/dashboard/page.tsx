"use client";

/**
 * Dashboard home — OpusClip-style launcher in ClipForge's brand orange:
 * promo banner, plan-upgrade bar, a central "get clips in 1 click" input
 * card, AI tools/recipe chips, demo projects and the user's projects below.
 */
import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { AnimatePresence, motion } from "framer-motion";
import { toast } from "sonner";
import {
  ArrowRight,
  Bot,
  Captions,
  Clapperboard,
  Crop,
  Crown,
  FileText,
  Gamepad2,
  Languages,
  Link2,
  Music4,
  Scan,
  Sparkles,
  Trophy,
  Upload,
  Wand2,
  X,
} from "lucide-react";

import { auth } from "@/lib/firebase";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ProjectCard } from "@/components/dashboard/project-card";
import { OnboardingCard } from "@/components/dashboard/onboarding-card";
import { Reveal } from "@/components/dashboard/reveal";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { Project } from "@/lib/types";

const PROMO_KEY = "cf-promo-dismissed";

/** Well-known Creative Commons sample videos (downloads cost no credits). */
const DEMO_PROJECTS = [
  {
    label: "Gaming stream highlights",
    icon: Gamepad2,
    gradient: "from-violet-600/70 via-purple-600/50 to-fuchsia-500/40",
    url: "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
    title: "Demo: Gaming stream",
  },
  {
    label: "Sports commentary",
    icon: Trophy,
    gradient: "from-emerald-600/70 via-teal-600/50 to-cyan-500/40",
    url: "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4",
    title: "Demo: Sports commentary",
  },
  {
    label: "Music interview",
    icon: Music4,
    gradient: "from-primary-600/70 via-primary-500/50 to-amber-500/40",
    url: "https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
    title: "Demo: Music interview",
  },
];

type ToolChip = {
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Where a working tool navigates; null = "Soon". */
  href: string | null;
  description: string;
};

const TOOL_CHIPS: ToolChip[] = [
  { label: "Preset templates", icon: Wand2, href: "/dashboard/new", description: "Start from a caption template" },
  { label: "Captions", icon: Captions, href: "/dashboard/new", description: "Animated word-by-word captions" },
  { label: "Clip gaming streams", icon: Gamepad2, href: "/dashboard/new", description: "Tune the AI for gameplay footage" },
  { label: "Auto-edit talking videos", icon: Bot, href: "/dashboard/new", description: "Best for podcasts & interviews" },
  { label: "Reframe to 9:16", icon: Crop, href: "/dashboard/new", description: "Every render is vertical by default" },
  { label: "AI B-roll", icon: Clapperboard, href: null, description: "Planned in the clip editor" },
  { label: "Social edits", icon: Link2, href: "/dashboard/connections", description: "Connect YouTube, TikTok, Instagram…" },
  { label: "Google Drive import", icon: Upload, href: null, description: "Import straight from Drive" },
  { label: "Upscale resolution", icon: Scan, href: null, description: "Enhance to higher resolution" },
  { label: "Clean up recording", icon: Sparkles, href: null, description: "Remove noise & filler words" },
  { label: "Translate & dub", icon: Languages, href: null, description: "Dub clips into other languages" },
];

export default function DashboardHome() {
  const router = useRouter();
  const urlInputRef = useRef<HTMLInputElement>(null);
  const [firstName, setFirstName] = useState<string>("there");
  const [userId, setUserId] = useState<string | null>(null);
  const [plan, setPlan] = useState<string>("free");
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"clips" | "transcript">("clips");
  const [promoHidden, setPromoHidden] = useState(true);
  const [showAllRecipes, setShowAllRecipes] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(true);

  // Per-user dismissal flags (keyed by uid so a shared browser stays tidy).
  useEffect(() => {
    setPromoHidden(localStorage.getItem(PROMO_KEY) === "1");
  }, []);

  // Profile bits for the greeting + upgrade bar + onboarding key.
  useEffect(() => {
    apiFetch<{ profile: { id?: string; display_name?: string | null; plan?: string } }>(
      "/api/me"
    )
      .then(({ profile }) => {
        const name = profile.display_name?.trim();
        if (name) setFirstName(name.split(" ")[0]);
        if (profile.plan) setPlan(profile.plan);
        if (profile.id) {
          setUserId(profile.id);
          setOnboardingDismissed(
            localStorage.getItem(`cf-onboarding-dismissed-${profile.id}`) === "1"
          );
        }
      })
      .catch(() => {});
  }, []);

  // Projects list — backend first, Firestore fallback (unchanged logic).
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    async function loadViaBackend(): Promise<Project[]> {
      const { projects } = await apiFetch<{ projects: Project[] }>("/api/projects");
      return projects ?? [];
    }

    async function loadViaFirestore(): Promise<Project[]> {
      const result = await Promise.race([
        supabase
          .from("projects")
          .select("*, clips(count)")
          .order("created_at", { ascending: false }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      if (result) {
        const { data, error } = result;
        if (!error && data) return data as Project[];
      }
      throw new Error("Firestore project read failed");
    }

    async function load() {
      try {
        const loaded = await loadViaBackend();
        if (!cancelled) setProjects(loaded);
      } catch (backendErr) {
        console.warn("Backend project read failed, using Firestore:", backendErr);
        try {
          const loaded = await loadViaFirestore();
          if (!cancelled) setProjects(loaded);
        } catch (e) {
          console.error("Failed to load projects:", e);
          if (!cancelled) setProjects((prev) => (prev === null ? [] : prev));
        }
      }
    }

    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) load();
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const newestProjectId = useMemo(() => projects?.[0]?.id ?? null, [projects]);

  // Onboarding: shown to NEW accounts only (no projects at first load) until
  // dismissed — existing accounts are marked eligible=false and never see it.
  // Once the pipeline completes the card celebrates, then auto-dismisses.
  const [onboardingEligible, setOnboardingEligible] = useState<boolean | null>(null);
  const eligibilityCheckedRef = useRef(false);
  const pipelineDone = (projects ?? []).some((p) => p.status === "done");
  const onboardingSteps = useMemo(
    () => [
      {
        key: "link",
        label: "Paste a video link and create your first project",
        done: (projects?.length ?? 0) > 0,
      },
      {
        key: "pipeline",
        label: "Watch the pipeline transcribe, analyze and render",
        done: pipelineDone,
      },
      {
        key: "share",
        label: "Open your project to download or schedule the clips",
        // The CTA unlocks with the finished render — completing all three.
        done: pipelineDone,
      },
    ],
    [projects, pipelineDone]
  );
  const allStepsDone = onboardingSteps.every((s) => s.done);
  const showOnboarding = onboardingEligible === true && !onboardingDismissed;

  function dismissOnboarding() {
    setOnboardingDismissed(true);
    if (userId) localStorage.setItem(`cf-onboarding-dismissed-${userId}`, "1");
  }

  // Decide eligibility on the first real projects load: an account that
  // already has projects skips onboarding permanently.
  useEffect(() => {
    if (projects === null || eligibilityCheckedRef.current) return;
    eligibilityCheckedRef.current = true;
    const dismissed = userId
      ? localStorage.getItem(`cf-onboarding-dismissed-${userId}`) === "1"
      : false;
    if (projects.length > 0 || dismissed) {
      setOnboardingEligible(false);
      setOnboardingDismissed(true);
    } else {
      setOnboardingEligible(true);
    }
  }, [projects, userId]);

  // Celebrate + auto-dismiss shortly after the first render finishes.
  useEffect(() => {
    if (!allStepsDone || !showOnboarding) return;
    const t = setTimeout(dismissOnboarding, 9000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allStepsDone, showOnboarding]);

  function handleChip(chip: ToolChip) {
    if (chip.href) {
      router.push(chip.href);
      return;
    }
    if (chip.label === "AI B-roll" && newestProjectId) {
      router.push(`/dashboard/projects/${newestProjectId}`);
      toast.info("AI B-roll lives in the clip editor — open any ready clip.");
      return;
    }
    toast.info(`${chip.label} is coming soon — stay tuned!`);
  }

  function createFromUrl() {
    const link = url.trim();
    if (!link) return;
    // Hand off to the create-project page with everything prefilled — the
    // user reviews clip settings there before the pipeline starts.
    router.push(
      `/dashboard/new?tab=url&mode=${mode}&url=${encodeURIComponent(link)}`
    );
  }

  // Returning users get their projects right under the input card — the
  // marketing sections (recipes, demos) step aside once they've shipped.
  const veteran = (projects?.length ?? 0) > 0;

  const projectsBlock = (
    <section>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground">Your projects</h2>
      </div>
      {projects === null ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        // While onboarding is visible the checklist card covers the empty
        // state — avoid repeating it twice on one screen.
        showOnboarding ? null : (
          <div className="mt-4 rounded-xl border border-dashed p-10 text-center">
            <p className="font-medium">No projects yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Paste a link above and ClipForge will find the viral moments for you.
            </p>
          </div>
        )
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          {projects.map((project, i) => (
            <Reveal key={project.id} delay={i * 0.05}>
              <ProjectCard
                project={project}
                onDeleted={(id) =>
                  setProjects((prev) => (prev ? prev.filter((p) => p.id !== id) : prev))
                }
              />
            </Reveal>
          ))}
        </div>
      )}
    </section>
  );

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      {/* Promo banner */}
      <AnimatePresence>
        {!promoHidden && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3 }}
            className="relative overflow-hidden rounded-xl border border-primary-500/40 bg-gradient-to-r from-primary-500/15 via-primary-500/10 to-transparent px-4 py-3"
          >
            <Link
              href="/dashboard/assistant"
              className="group flex items-center gap-2 text-sm"
            >
              <Sparkles className="h-4 w-4 shrink-0 text-primary-500" />
              <span className="flex-1">
                <span className="font-medium">The new ClipForge is live:</span>{" "}
                <span className="text-muted-foreground">
                  multi-chat AI assistant, manual timeline editor & transcript exports.
                </span>{" "}
                <span className="inline-flex items-center gap-0.5 font-medium text-primary-600 dark:text-primary-400">
                  Try it <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </span>
            </Link>
            <button
              type="button"
              aria-label="Dismiss banner"
              className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setPromoHidden(true);
                localStorage.setItem(PROMO_KEY, "1");
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Plan upgrade bar (free plan only) */}
      {plan === "free" && (
        <Reveal>
          <div className="flex flex-wrap items-center justify-center gap-3 rounded-xl border bg-muted/50 px-4 py-2.5 text-sm">
            <Crown className="h-4 w-4 text-primary-500" />
            <span className="text-muted-foreground">
              Unlock watermark-free exports and more clips per video.
            </span>
            <Button asChild size="sm" variant="outline" className="border-primary-500/60 text-primary-600 hover:bg-primary-500/10 dark:text-primary-400">
              <Link href="/dashboard/upgrade">Upgrade plan</Link>
            </Button>
          </div>
        </Reveal>
      )}

      {/* Main input card */}
      <Reveal delay={0.05}>
        <div className="mx-auto w-full max-w-2xl">
          <div className="mb-3 flex items-end justify-between">
            <div className="flex gap-1 rounded-lg bg-muted p-1">
              <button
                type="button"
                onClick={() => setMode("clips")}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  mode === "clips"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Clapperboard className="h-4 w-4" /> Clip long video
              </button>
              <button
                type="button"
                onClick={() => setMode("transcript")}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  mode === "transcript"
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <FileText className="h-4 w-4" /> Transcript only
              </button>
            </div>
            {newestProjectId ? (
              <Button asChild variant="ghost" size="sm" className="text-muted-foreground">
                <Link href={`/dashboard/projects/${newestProjectId}`}>
                  <Wand2 /> Open editor
                </Link>
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                disabled
                title="Create a project first"
              >
                <Wand2 /> Open editor
              </Button>
            )}
          </div>

          <div className="rounded-2xl border bg-card p-4 shadow-sm">
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                createFromUrl();
              }}
            >
              <div className="relative flex-1">
                <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={urlInputRef}
                  type="url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="Paste a YouTube, Twitch or podcast link"
                  className="h-11 pl-9"
                  required
                />
              </div>
              <Button type="submit" size="lg" className="h-11">
                <Sparkles />
                {mode === "transcript" ? "Transcribe in 1 click" : "Get clips in 1 click"}
              </Button>
            </form>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
              <Link
                href="/dashboard/new?tab=upload"
                className="inline-flex items-center gap-1.5 transition-colors hover:text-primary-600 dark:hover:text-primary-400"
              >
                <Upload className="h-4 w-4" /> Upload a file
              </Link>
              <Link
                href={`/dashboard/new?url=${encodeURIComponent(DEMO_PROJECTS[0].url)}&title=${encodeURIComponent(DEMO_PROJECTS[0].title)}`}
                className="inline-flex items-center gap-1.5 transition-colors hover:text-primary-600 dark:hover:text-primary-400"
              >
                <Sparkles className="h-4 w-4" /> Try a sample project
              </Link>
              <span className="inline-flex items-center gap-1.5 cursor-default">
                <Upload className="h-4 w-4" /> Google Drive
                <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase text-muted-foreground">
                  Soon
                </span>
              </span>
            </div>
          </div>
        </div>
      </Reveal>

      {/* First-run onboarding — hidden once any project renders or it's dismissed */}
      <OnboardingCard
        active={showOnboarding}
        steps={onboardingSteps}
        onDismiss={dismissOnboarding}
        onOpenProject={dismissOnboarding}
        newestProjectId={newestProjectId}
        onPasteLink={() => {
          urlInputRef.current?.focus();
          urlInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}
      />

      {/* Veterans get their work right under the input card */}
      {veteran && projectsBlock}

      {/* AI tools & quick recipes */}
      <Reveal delay={0.1}>
        <div className="text-center">
          <div className="mx-auto flex max-w-3xl flex-wrap justify-center gap-2">
            {(showAllRecipes ? TOOL_CHIPS : TOOL_CHIPS.slice(0, 7)).map((chip, i) => (
              <motion.button
                key={chip.label}
                type="button"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.03, duration: 0.25 }}
                onClick={() => handleChip(chip)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm transition-colors",
                  chip.href
                    ? "hover:border-primary-500/60 hover:text-primary-600 dark:hover:text-primary-400"
                    : "text-muted-foreground"
                )}
                title={chip.description}
              >
                <chip.icon className="h-3.5 w-3.5 text-primary-500" />
                {chip.label}
                {!chip.href && (
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase text-muted-foreground">
                    Soon
                  </span>
                )}
              </motion.button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setShowAllRecipes((v) => !v)}
            className="mt-3 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-primary-600 dark:hover:text-primary-400"
          >
            {showAllRecipes ? "Show fewer" : "See all Recipes"}
            <ArrowRight className={cn("h-3.5 w-3.5 transition-transform", showAllRecipes && "rotate-90")} />
          </button>
        </div>
      </Reveal>

      {/* Demo projects — onboarding material; veterans don't need it */}
      {!veteran && (
        <Reveal delay={0.15}>
          <section>
            <h2 className="text-sm font-semibold text-muted-foreground">Start from a demo project</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {DEMO_PROJECTS.map((demo) => (
                <Link
                  key={demo.title}
                  href={`/dashboard/new?url=${encodeURIComponent(demo.url)}&title=${encodeURIComponent(demo.title)}`}
                  className="group overflow-hidden rounded-xl border transition-colors hover:border-primary-500/60"
                >
                  <div
                    className={cn(
                      "relative flex h-28 items-end bg-gradient-to-br p-3",
                      demo.gradient
                    )}
                  >
                    <demo.icon className="absolute right-3 top-3 h-5 w-5 text-white/70" />
                    <p className="text-sm font-semibold text-white drop-shadow">{demo.label}</p>
                  </div>
                  <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
                    Use as starting point
                    <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 group-hover:text-primary-500" />
                  </div>
                </Link>
              ))}
            </div>
          </section>
        </Reveal>
      )}

      {/* Newcomers find their projects at the bottom, below the tour */}
      {!veteran && projectsBlock}
    </div>
  );
}
