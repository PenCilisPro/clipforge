"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { auth, firestore } from "@/lib/firebase";
import { doc, getDoc } from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { isAdminEmail } from "@/lib/admin";
import { DashboardShell } from "@/components/dashboard/shell";

/**
 * Client-side admin guard (Firebase sessions live in IndexedDB, so SSR
 * can't see them). Force-refreshes the ID token so a freshly-stamped admin
 * claim shows up on the first visit, and falls back to the client allowlist
 * (the backend's /api/admin gate remains the real enforcement point).
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
    let unsub: (() => void) | undefined;
    let cancelled = false;

    async function loadUser(user: {
      uid: string;
      email: string | null;
    } | null) {
      if (!user) {
        router.replace("/login");
        return;
      }
      const email = user.email ?? "";
      // Force refresh so claims stamped server-side on a previous request
      // (or just now) are visible without waiting for the token to age out.
      let admin = false;
      try {
        const result = await auth.currentUser?.getIdTokenResult(true);
        admin = result?.claims.admin === true;
      } catch {
        admin = false;
      }
      // Allowlist fallback covers the window before the backend has stamped
      // the custom claim (first visit after sign-in).
      if (!admin && !isAdminEmail(email)) {
        router.replace("/dashboard");
        return;
      }
      let profileData: Record<string, unknown> | null = null;
      try {
        const snap = await getDoc(doc(firestore, "profiles", user.uid));
        profileData = snap.exists() ? { id: snap.id, ...snap.data() } : null;
      } catch {
        profileData = null;
      }
      if (cancelled) return;
      setState({
        checked: true,
        user: { id: user.uid, email, admin },
        profile: profileData,
      });
    }

    unsub = onAuthStateChanged(auth, (u) => {
      if (u) {
        loadUser(u);
      } else {
        router.replace("/login");
      }
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
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
