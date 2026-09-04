import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { env } from "../config/env.js";

const router = Router();

const MOODS = [
  "upbeat",
  "chill",
  "dramatic",
  "corporate",
  "energetic",
  "happy",
  "epic",
  "background",
];

// Fully constant request — no request data ever reaches the outbound URL
// (SSRF-safe by construction). One catalog fetch covers every mood; the
// mood filter is applied locally against the tags Jamendo returns.
// audioformat must be mp31 (Jamendo rejects "mp3").
const JAMENDO_CATALOG_URL =
  "https://api.jamendo.com/v3.0/tracks/?format=json&limit=60&audioformat=mp31&include=musicinfo";

// Catalog → { tracks, ts } cache (24h) to keep Jamendo API calls low.
const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function fetchCatalog() {
  const cached = cache.get("catalog");
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.tracks;

  const upstream = await fetch(
    `${JAMENDO_CATALOG_URL}&client_id=${encodeURIComponent(env.jamendoClientId)}`,
    { signal: AbortSignal.timeout(10_000) }
  );
  if (!upstream.ok) {
    throw new Error(`Jamendo request failed (${upstream.status})`);
  }
  const data = await upstream.json();
  const tracks = (data?.results ?? [])
    .filter((t) => t.audio && t.name)
    .map((t) => ({
      id: String(t.id),
      name: String(t.name).slice(0, 200),
      artist: String(t.artist_name ?? "Unknown artist").slice(0, 200),
      duration: Number(t.duration ?? 0),
      audio: String(t.audio),
      image: t.image ? String(t.image) : null,
      // Local mood matching uses these; stripped before responding.
      tags: [
        ...(t.musicinfo?.tags?.genres ?? []),
        ...(t.musicinfo?.tags?.vartags ?? []),
      ].map((tag) => String(tag).toLowerCase()),
    }));

  cache.set("catalog", { tracks, ts: Date.now() });
  return tracks;
}

/**
 * Curated background-music search (Jamendo). Auth-gated so the client id
 * isn't abused by anonymous traffic; the catalog is cached for a day and
 * filtered locally by mood.
 */
router.get("/api/music", requireAuth, async (req, res, next) => {
  try {
    if (!env.jamendoClientId) {
      return res.json({ configured: false, tracks: [] });
    }

    const mood = MOODS.includes(String(req.query.mood)) ? String(req.query.mood) : "background";

    const allTracks = await fetchCatalog();
    const strip = ({ tags, ...track }) => track;
    const matching = allTracks.filter((t) => t.tags.includes(mood)).map(strip);
    // No tagged match for this mood — offer the catalog rather than nothing.
    const tracks = matching.length > 0 ? matching : allTracks.slice(0, 10).map(strip);

    res.json({ configured: true, mood, tracks });
  } catch (err) {
    next(err);
  }
});

export default router;
