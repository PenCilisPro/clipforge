import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DashboardShell } from "@/components/dashboard/shell";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  return (
    <DashboardShell
      user={{
        id: user.id,
        email: user.email ?? "",
        displayName:
          (profile?.display_name as string | null) ??
          user.email?.split("@")[0] ??
          "Creator",
        avatarUrl: (profile?.avatar_url as string | null) ?? null,
      }}
      profile={
        profile
          ? {
              plan: profile.plan,
              creditsRemaining: Number(profile.credits_remaining),
            }
          : { plan: "free", creditsRemaining: 0 }
      }
    >
      {children}
    </DashboardShell>
  );
}
