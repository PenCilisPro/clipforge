"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  BarChart3,
  Bot,
  CalendarClock,
  House,
  Link2,
  Menu,
  MessageSquare,
  PlusCircle,
  ShieldCheck,
  Sparkles,
  Tag,
  X,
  Zap,
} from "lucide-react";

import { ThemeToggle } from "@/components/theme-toggle";
import { Logo } from "@/components/logo";
import { UserMenu } from "@/components/dashboard/user-menu";
import { NotificationsBell } from "@/components/dashboard/notifications-bell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isAdminEmail } from "@/lib/admin";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  // The dashboard launcher — the first tab users see after login. Creating a
  // project lives on Home's input card (no separate sidebar item).
  { label: "Home", href: "/dashboard", icon: House },
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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navItems = isAdminEmail(user.email) ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS;

  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);

  // Close the drawer whenever the route changes.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Full sidebar content — shared by the desktop aside and the mobile drawer.
  const sidebarContent = (
    <>
      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {navItems.map((item) => {
          const active = isActive(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setDrawerOpen(false)}
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
    </>
  );

  // The clip editor is a full-screen, distraction-free workspace (like the
  // big streaming platforms' editors): render it without the dashboard
  // sidebar/header, with its own dark chrome.
  const isClipEditor =
    /^\/dashboard\/projects\/[^/]+\/clips\/[^/]+\/?$/.test(pathname ?? "");
  if (isClipEditor) {
    return <div className="min-h-screen bg-[#101013] text-[#f4f4f5]">{children}</div>;
  }

  return (
    <div className="flex min-h-screen">
      {/* Sidebar (desktop) */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-card md:flex">
        <div className="flex h-16 items-center border-b px-5">
          <Logo href="/dashboard" />
        </div>
        {sidebarContent}
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {drawerOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm md:hidden"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          >
            <motion.aside
              initial={{ x: -300 }}
              animate={{ x: 0 }}
              exit={{ x: -300 }}
              transition={{ type: "spring", damping: 28, stiffness: 320 }}
              className="flex h-full w-72 flex-col border-r bg-card shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex h-16 items-center justify-between border-b px-5">
                <Logo href="/dashboard" />
                <button
                  type="button"
                  aria-label="Close menu"
                  className="rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => setDrawerOpen(false)}
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              {sidebarContent}
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b bg-background/80 px-4 backdrop-blur-lg md:px-6">
          <div className="flex items-center gap-2">
            {/* Hamburger opens the sidebar drawer on mobile */}
            <button
              type="button"
              aria-label="Open menu"
              className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
              onClick={() => setDrawerOpen(true)}
            >
              <Menu className="h-5 w-5" />
            </button>
            <Logo href="/dashboard" className="md:hidden" />
          </div>
          <div className="hidden items-center gap-2 text-sm text-muted-foreground md:flex">
            <Sparkles className="h-4 w-4 text-primary-500" />
            <span>Welcome back, {user.displayName.split(" ")[0]}</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="px-2 font-medium text-foreground sm:px-3"
              title="Your remaining credits"
            >
              <Link href="/dashboard/billing">
                <Zap className="h-4 w-4 text-primary-500" />
                <span className="tabular-nums">{profile.creditsRemaining}</span>
              </Link>
            </Button>
            <Button asChild size="sm" className="hidden px-3 sm:inline-flex">
              <Link href="/dashboard/billing">
                <PlusCircle className="h-4 w-4" /> Add credits
              </Link>
            </Button>
            <NotificationsBell />
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
