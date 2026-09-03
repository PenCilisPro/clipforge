"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSearchParams } from "next/navigation";
import {
  CheckCircle2,
  Facebook,
  Instagram,
  Link2,
  Loader2,
  Music2,
  Plus,
  Trash2,
  Youtube,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { formatDateTime } from "@/lib/utils";
import type { Platform, SocialConnection } from "@/lib/types";

const PLATFORMS: {
  key: Platform;
  label: string;
  icon: typeof Youtube;
  description: string;
}[] = [
  {
    key: "youtube",
    label: "YouTube Shorts",
    icon: Youtube,
    description: "Upload vertical clips as Shorts on your channel.",
  },
  {
    key: "instagram",
    label: "Instagram Reels",
    icon: Instagram,
    description: "Publish Reels to a professional/business account.",
  },
  {
    key: "tiktok",
    label: "TikTok",
    icon: Music2,
    description: "Post clips directly to your TikTok profile.",
  },
  {
    key: "facebook",
    label: "Facebook Reels",
    icon: Facebook,
    description: "Publish Reels to your Facebook page.",
  },
];

export default function ConnectionsPage() {
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createClient(), []);
  const [connections, setConnections] = useState<SocialConnection[] | null>(null);
  const [connecting, setConnecting] = useState<Platform | null>(null);

  useEffect(() => {
    load();

    const status = searchParams.get("status");
    const platform = searchParams.get("platform");
    if (status === "connected" && platform) {
      toast.success(`${platform} connected`);
    } else if (status === "error") {
      toast.error(`Could not connect ${platform ?? "account"}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    const { data } = await supabase
      .from("social_connections")
      .select("id, user_id, platform, platform_account_id, platform_username, connected_at");
    setConnections((data as SocialConnection[]) ?? []);
  }

  async function handleConnect(platform: Platform) {
    setConnecting(platform);
    try {
      // Backend returns the OAuth authorize URL for this platform
      // (it validates the Supabase JWT from the Authorization header).
      const { authorizeUrl } = await apiFetch<{ authorizeUrl: string }>(
        `/api/social/${platform}/connect`
      );
      window.location.href = authorizeUrl;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start OAuth");
      setConnecting(null);
    }
  }

  async function handleDisconnect(platform: Platform) {
    try {
      await apiFetch(`/api/social/connections/${platform}`, { method: "DELETE" });
      toast.success(`${platform} disconnected`);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Disconnect failed");
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold tracking-tight">Social Connections</h1>
      <p className="text-sm text-muted-foreground">
        Connect your accounts once to enable auto-publishing. Tokens are
        encrypted at rest.
      </p>

      <div className="mt-6 space-y-4">
        {PLATFORMS.map((platform) => {
          const connection = connections?.find(
            (c) => c.platform === platform.key
          );
          return (
            <Card key={platform.key}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-500/10">
                      <platform.icon className="h-5 w-5 text-primary-500" />
                    </div>
                    <div>
                      <CardTitle className="text-base">{platform.label}</CardTitle>
                      <CardDescription>{platform.description}</CardDescription>
                    </div>
                  </div>
                  {connection && (
                    <Badge
                      variant="outline"
                      className="border-transparent bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    >
                      <CheckCircle2 className="mr-1 h-3 w-3" /> Connected
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex items-center justify-between">
                {connection ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      @{connection.platform_username ?? connection.platform_account_id ?? "account"}{" "}
                      · connected {formatDateTime(connection.connected_at)}
                    </p>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() => handleDisconnect(platform.key)}
                    >
                      <Trash2 /> Disconnect
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Not connected yet
                    </p>
                    <Button
                      size="sm"
                      onClick={() => handleConnect(platform.key)}
                      disabled={connecting !== null}
                    >
                      {connecting === platform.key ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Link2 />
                      )}
                      Connect
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="mt-8 rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
        <p className="flex items-center gap-2 font-medium text-foreground">
          <Plus className="h-3.5 w-3.5 text-primary-500" />
          Why connect accounts?
        </p>
        <p className="mt-1">
          Connecting is only required for auto-scheduling and publishing. You
          can always download clips and post them manually.
        </p>
      </div>
    </div>
  );
}
