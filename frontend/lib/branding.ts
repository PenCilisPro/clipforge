"use client";

import { useEffect, useState } from "react";

import { API_URL } from "@/lib/api";

export interface Branding {
  logoUrl: string | null;
  faviconUrl: string | null;
}

const FALLBACK: Branding = { logoUrl: null, faviconUrl: null };

let cached: Branding | null = null;
let inflight: Promise<Branding> | null = null;
let appliedFavicon: string | null = null;
const listeners = new Set<(b: Branding) => void>();

async function fetchBranding(): Promise<Branding> {
  if (cached) return cached;
  if (!inflight) {
    inflight = fetch(`${API_URL}/api/branding`, { cache: "no-store" })
      .then(async (res): Promise<Branding> => {
        if (!res.ok) return FALLBACK;
        const data = await res.json();
        cached = { logoUrl: data.logoUrl ?? null, faviconUrl: data.faviconUrl ?? null };
        return cached;
      })
      .catch(() => FALLBACK);
  }
  return inflight;
}

/**
 * Swap the browser-tab icon for the custom branding. The static Next.js icon
 * links (app/icon.svg) are removed first — with both in the head Chrome can
 * keep showing the built-in bolt even after a reload.
 */
function applyFavicon(faviconUrl: string) {
  if (!/^https?:\/\//i.test(faviconUrl) || appliedFavicon === faviconUrl) return;
  appliedFavicon = faviconUrl;
  document
    .querySelectorAll<HTMLLinkElement>('link[rel*="icon"]')
    .forEach((el) => el.remove());
  for (const rel of ["icon", "shortcut icon", "apple-touch-icon"]) {
    const link = document.createElement("link");
    link.rel = rel;
    link.href = faviconUrl;
    document.head.appendChild(link);
  }
}

/** Restore the built-in ClipForge tab icon (admin hit "Reset to default"). */
function resetFavicon() {
  if (!appliedFavicon) return;
  appliedFavicon = null;
  document.querySelectorAll<HTMLLinkElement>('link[rel*="icon"]').forEach((el) => el.remove());
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/svg+xml";
  link.href = "/icon.svg";
  document.head.appendChild(link);
}

/** Custom logo uploaded from the admin page (falls back to the default mark). */
export function useBranding(): Branding {
  const [branding, setBranding] = useState<Branding>(cached ?? FALLBACK);

  useEffect(() => {
    listeners.add(setBranding);
    let alive = true;
    fetchBranding().then((b) => {
      if (!alive) return;
      setBranding(b);
      if (b.faviconUrl) applyFavicon(b.faviconUrl);
    });
    return () => {
      alive = false;
      listeners.delete(setBranding);
    };
  }, []);

  return branding;
}

/**
 * Re-fetch branding right away (admin just uploaded or reset the logo) so
 * mounted components and the tab icon update without a page reload.
 */
export async function refreshBranding(): Promise<Branding> {
  cached = null;
  inflight = null;
  const branding = await fetchBranding();
  listeners.forEach((notify) => notify(branding));
  if (branding.faviconUrl) applyFavicon(branding.faviconUrl);
  else resetFavicon();
  return branding;
}
