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

// Keyword → { tracks, ts } cache (24h) to keep Jamendo API calls low.
const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Curated background-music search (Jamendo). Auth-gated so the client id
 * isn't abused by anonymous traffic; results are cached per mood for a day.
 */
router.get("/api/music", requireAuth, async (req, res, next) => {
  try {
    if (!env.jamendoClientId) {
      return res.json({ configured: false, tracks: [] });
    }

    const mood = MOODS.includes(String(req.query.mood)) ? String(req.query.mood) : "background";
    const cached = cache.get(mood);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return res.json({ configured: true, mood, tracks: cached.tracks });
    }

    const url =
      `https://api.jamendo.com/v3.0/tracks/?client_id=${encodeURIComponent(env.jamendoClientId)}` +
      `&format=json&limit=10&tags=${encodeURIComponent(mood)}&audioformat=mp3&include=musicinfo`;

    const upstream = await fetch(url, { signal: AbortSignal.timeout(10_000) });
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
      }));

    cache.set(mood, { tracks, ts: Date.now() });
    res.json({ configured: true, mood, tracks });
  } catch (err) {
    next(err);
  }
});

export default router;
