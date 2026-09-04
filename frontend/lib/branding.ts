"use client";

import { useEffect, useState } from "react";

import { API_URL } from "@/lib/api";

export interface Branding {
  logoUrl: string | null;
  faviconUrl: string | null;
}

let cached: Branding | null = null;
let inflight: Promise<Branding> | null = null;
let iconApplied = false;

async function loadBranding(): Promise<Branding> {
  if (cached) return cached;
  if (!inflight) {
    inflight = fetch(`${API_URL}/api/branding`, { cache: "no-store" })
      .then(async (res): Promise<Branding> => {
        if (!res.ok) return { logoUrl: null, faviconUrl: null };
        const data = await res.json();
        cached = { logoUrl: data.logoUrl ?? null, faviconUrl: data.faviconUrl ?? null };
        return cached;
      })
      .catch(() => ({ logoUrl: null, faviconUrl: null }) as Branding);
  }
  return inflight;
}

/** Swap the browser-tab icon for the custom branding (client-side, runs once). */
function applyFavicon(faviconUrl: string) {
  if (iconApplied || !/^https:\/\//i.test(faviconUrl)) return;
  iconApplied = true;
  for (const rel of ["icon", "shortcut icon", "apple-touch-icon"]) {
    const link = document.createElement("link");
    link.rel = rel;
    link.href = faviconUrl;
    document.head.appendChild(link);
  }
}

/** Custom logo uploaded from the admin page (falls back to the default mark). */
export function useBranding(): Branding {
  const [branding, setBranding] = useState<Branding>(cached ?? { logoUrl: null, faviconUrl: null });

  useEffect(() => {
    loadBranding().then((b) => {
      setBranding(b);
      if (b.faviconUrl) applyFavicon(b.faviconUrl);
    });
  }, []);

  return branding;
}
