"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api";
import { DashboardShell } from "@/components/dashboard/shell";

/**
 * Firebase has no server-side session for SSR (browser session lives in
 * IndexedDB), so this guard runs client-side: wait for auth state, redirect
 * to /login when signed out, and load the profile document.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [state, setState] = useState<{
    checked: boolean;
    user?: { id: string; email: string };
    profile?: Record<string, unknown> | null;
  }>({ checked: false });

  useEffect(() => {
    const supabase = createClient();
    let unsub: (() => void) | undefined;

    async function loadUser() {
      const { data } = await supabase.auth.getUser();
      const user = data.user as { id: string; email: string } | null;
      if (!user) {
        router.replace("/login");
        return;
      }
      // A rejected profile read (e.g. Firestore rules race on a brand-new
      // user) must not leave the layout rendering null forever.
      let profileData: Record<string, unknown> | null = null;
      try {
        const { data } = await supabase
          .from("profiles")
          .select("*")
          .eq("id", user.id)
          .single();
        profileData = data;
      } catch {
        profileData = null;
      }
      if (!profileData) {
        // Fall back to the backend (admin SDK), which reads the same profile
        // document bypassing security rules — covers rules races and docs
        // created server-side that the client SDK couldn't read yet.
        try {
          const { profile } = await apiFetch<{
            profile: Record<string, unknown>;
          }>("/api/me");
          if (profile) profileData = profile;
        } catch {
          // backend unreachable — keep null and render the defaults
        }
      }
      setState({ checked: true, user, profile: profileData });
    }

    loadUser();
    unsub = supabase.auth.onAuthStateChanged((u) => {
      if (!u) router.replace("/login");
    });
    return () => unsub?.();
  }, [router]);

  if (!state.checked || !state.user) {
    return null;
  }

  const user = state.user;
  const profile = state.profile ?? null;

  return (
    <DashboardShell
      user={{
        id: user.id,
        email: user.email ?? "",
        displayName:
          ((profile?.display_name as string | null) ??
            user.email?.split("@")[0] ??
            "Creator") as string,
        avatarUrl: (profile?.avatar_url as string | null) ?? null,
      }}
      profile={
        profile
          ? {
              plan: (profile.plan as string) || "free",
              creditsRemaining: Number(profile.credits_remaining) || 0,
            }
          : { plan: "free", creditsRemaining: 0 }
      }
    >
      {children}
    </DashboardShell>
  );
}
