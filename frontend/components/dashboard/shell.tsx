"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Bot,
  CalendarClock,
  Clapperboard,
  Link2,
  MessageSquare,
  ShieldCheck,
  Sparkles,
  Tag,
  Zap,
} from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";
import { Logo } from "@/components/logo";
import { UserMenu } from "@/components/dashboard/user-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isAdminEmail } from "@/lib/admin";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { label: "Projects", href: "/dashboard", icon: Clapperboard },
  { label: "Analytics", href: "/dashboard/analytics", icon: BarChart3 },
  { label: "Calendar", href: "/dashboard/calendar", icon: CalendarClock },
  { label: "AI Assistant", href: "/dashboard/assistant", icon: Bot },
  { label: "Connections", href: "/dashboard/connections", icon: Link2 },
  { label: "Feedback", href: "/dashboard/feedback", icon: MessageSquare },
];

const ADMIN_NAV_ITEM = { label: "Admin", href: "/admin", icon: ShieldCheck };

export interface ShellUser {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface ShellProfile {
  plan: string;
  creditsRemaining: number;
}

export function DashboardShell({
  user,
  profile,
  children,
}: {
  user: ShellUser;
  profile: ShellProfile;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const navItems = isAdminEmail(user.email) ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS;

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-card md:flex">
        <div className="flex h-16 items-center border-b px-5">
          <Logo href="/dashboard" />
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {navItems.map((item) => {
            const active =
              item.href === "/dashboard"
                ? pathname === "/dashboard"
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary-500/10 text-primary-600 dark:text-primary-400"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
                {active && (
                  <span className="ml-auto h-4 w-1 rounded-full bg-primary-500" />
                )}
              </Link>
            );
          })}
        </nav>
        <div className="border-t p-4">
          <div className="rounded-lg bg-muted/60 p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Zap className="h-4 w-4 text-primary-500" />
              {profile.creditsRemaining} credits left
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              1 credit = 1 minute of video
            </p>
            <Badge variant="secondary" className="mt-2 capitalize">
              {profile.plan} plan
            </Badge>
          </div>
          <div className="mt-3 flex gap-3 px-1 text-[11px] text-muted-foreground">
            <Link href="/privacy" className="hover:text-foreground">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-foreground">
              Terms
            </Link>
            <Link href="/pricing" className="hover:text-foreground">
              Pricing
            </Link>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b bg-background/80 px-4 backdrop-blur-lg md:px-6">
          <div className="flex items-center gap-2">
            {/* Sidebar (and its logo) is hidden on mobile — keep the brand visible */}
            <Logo href="/dashboard" className="md:hidden" />
            {/* Mobile nav */}
            <nav className="flex items-center gap-1 md:hidden">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "rounded-md p-2",
                    (item.href === "/dashboard"
                      ? pathname === "/dashboard"
                      : pathname.startsWith(item.href))
                      ? "bg-primary-500/10 text-primary-600 dark:text-primary-400"
                      : "text-muted-foreground"
                  )}
                >
                  <item.icon className="h-5 w-5" />
                </Link>
              ))}
            </nav>
          </div>
          <div className="hidden items-center gap-2 text-sm text-muted-foreground md:flex">
            <Sparkles className="h-4 w-4 text-primary-500" />
            <span>Welcome back, {user.displayName.split(" ")[0]}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="px-2 sm:px-3">
              <Link href="/pricing">
                <Tag className="h-4 w-4" />
                <span className="hidden sm:inline">Pricing</span>
              </Link>
            </Button>
            <ThemeToggle />
            <UserMenu user={user} />
          </div>
        </header>
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
