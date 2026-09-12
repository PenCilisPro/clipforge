"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { DashboardShell } from "@/components/dashboard/shell";

/**
 * Client-side admin guard (Firebase sessions live in IndexedDB, so SSR
 * can't see them). Verifies the admin custom claim before rendering.
 */
export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [state, setState] = useState<{
    checked: boolean;
    user?: { id: string; email: string; admin?: boolean };
    profile?: Record<string, unknown> | null;
  }>({ checked: false });

  useEffect(() => {
    const supabase = createClient();
    let unsub: (() => void) | undefined;

    async function loadUser() {
      const { data } = await supabase.auth.getUser();
      const user = data.user as
        | { id: string; email: string; admin?: boolean }
        | null;
      if (!user) {
        router.replace("/login");
        return;
      }
      if (!user.admin) {
        router.replace("/dashboard");
        return;
      }
      const { data: profileData } = await supabase
        .from("profiles")
        .select("*")
        .eq("id", user.id)
        .single();
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
              plan: profile.plan as string,
              creditsRemaining: Number(profile.credits_remaining),
            }
          : { plan: "free", creditsRemaining: 0 }
      }
    >
      {children}
    </DashboardShell>
  );
}
