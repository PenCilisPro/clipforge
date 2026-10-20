/**
 * Transcript helpers — convert word-level Speech-to-Text output into
 * SRT captions and render-provider-friendly caption data.
 */

function formatSrtTime(seconds) {
  const total = Math.max(0, seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const pad = (n, len = 2) => n.toString().padStart(len, "0");
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
}

/**
 * Group words into caption lines of at most `maxWords` words / `maxChars`
 * characters, broken at natural pauses. Times are shifted relative to the
 * clip start (clip-local).
 */
export function groupWordsIntoCues(words, { startOffset = 0, maxWords = 4, maxChars = 24 } = {}) {
  const cues = [];
  let current = { words: [], start: null, end: null };

  const flush = () => {
    if (current.words.length > 0 && current.start != null) {
      cues.push({
        start: Math.max(0, current.start - startOffset),
        end: Math.max(0, current.end - startOffset),
        text: current.words.map((w) => w.text).join(" "),
        // Word timings relative to the clip start — used for word-sync
        // caption highlighting.
        words: current.words.map((w) => ({
          text: w.text,
          start: Math.max(0, w.start - startOffset),
          end: Math.max(0, w.end - startOffset),
        })),
      });
    }
    current = { words: [], start: null, end: null };
  };

  for (const word of words) {
    const text = String(word.word ?? "").trim();
    if (!text) continue;
    const wStart = Number(word.start ?? 0);
    const wEnd = Number(word.end ?? wStart + 0.2);

    if (current.start == null) current.start = wStart;
    current.words.push({ text, start: wStart, end: wEnd });
    current.end = wEnd;

    const chars = current.words.map((w) => w.text).join(" ").length;
    const pauseAfter = wEnd - Number(words[words.indexOf(word) + 1]?.start ?? wEnd) > 0.6;
    const isSentenceEnd = /[.!?]$/.test(text);

    if (current.words.length >= maxWords || chars >= maxChars || pauseAfter || isSentenceEnd) {
      flush();
    }
  }
  flush();

  return cues;
}

/** Build an SRT string from grouped cues. */
export function cuesToSrt(cues) {
  return cues
    .map(
      (cue, i) =>
        `${i + 1}\n${formatSrtTime(cue.start)} --> ${formatSrtTime(
          Math.max(cue.end, cue.start + 0.4)
        )}\n${cue.text}\n`
    )
    .join("\n");
}

/**
 * Full pipeline helper: transcript JSON (as stored in projects.transcript_json)
 * + clip window → { cues, srt }.
 */
export function buildCaptionsForClip(transcriptJson, clipStart, clipEnd) {
  const words = (transcriptJson?.words ?? []).filter(
    (w) => Number(w.end) > clipStart && Number(w.start) < clipEnd
  );
  const cues = groupWordsIntoCues(words, { startOffset: clipStart });
  return { cues, srt: cuesToSrt(cues) };
}

/**
 * Attach clip-local word timings to cues parsed from a manual SRT override.
 *
 * Transcript words are matched against the cue text sequentially (punctuation
 * and case insensitive); any word that can't be matched gets a proportional
 * slice of the cue based on character length. Every cue leaves with a
 * `words: [{text, start, end}]` array so renders can highlight the
 * currently-spoken word.
 */
export function attachWordTimings(cues, transcriptJson, clipStart, clipEnd) {
  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9']/g, "");

  const transcript = (transcriptJson?.words ?? [])
    .map((w) => ({ text: String(w.word ?? ""), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.text && w.end > clipStart && w.start < clipEnd)
    .map((w) => ({ ...w, key: norm(w.text) }));
  let cursor = 0;

  for (const cue of cues) {
    const textWords = String(cue.text ?? "").trim().split(/\s+/).filter(Boolean);
    const matches = [];
    for (const raw of textWords) {
      const key = norm(raw);
      let hit = null;
      if (key) {
        for (let look = 0; look <= 4 && cursor + look < transcript.length; look++) {
          if (transcript[cursor + look].key === key) {
            hit = cursor + look;
            break;
          }
        }
      }
      if (hit != null) {
        matches.push({ text: raw, start: transcript[hit].start, end: transcript[hit].end });
        cursor = hit + 1;
      } else {
        matches.push({ text: raw, start: null, end: null });
      }
    }

    // Unmatched words share the gap between their matched neighbours
    // (proportionally by character length); matched words keep STT times.
    const cueStartG = Number(cue.start) + clipStart;
    const cueEndG = Number(cue.end) + clipStart;
    const timed = [];
    let prevEnd = cueStartG;
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      if (m.start != null && m.end > m.start) {
        timed.push({ text: m.text, start: m.start, end: m.end });
        prevEnd = m.end;
        continue;
      }
      let j = i;
      while (j < matches.length && !(matches[j].start != null && matches[j].end > matches[j].start)) j++;
      const nextStart = j < matches.length ? matches[j].start : cueEndG;
      const run = matches.slice(i, j);
      const totalChars = run.reduce((s, w) => s + w.text.length, 0) || 1;
      const gap = Math.max(0, nextStart - prevEnd);
      let t = prevEnd;
      for (const w of run) {
        const slice = (w.text.length / totalChars) * gap;
        timed.push({ text: w.text, start: t, end: t + slice });
        t += slice;
      }
      prevEnd = t;
      i = j - 1;
    }

    cue.words = timed
      .map((w) => ({
        text: w.text,
        start: Math.max(Number(cue.start), w.start - clipStart),
        end: Math.min(Number(cue.end), w.end - clipStart),
      }))
      .filter((w) => w.end > w.start);
  }

  return cues;
}

/**
 * Parse SRT text back into cues [{start, end, text}] (clip-local seconds).
 * Used for caption overrides saved from the clip editor.
 */
export function parseSrt(srt) {
  const cues = [];
  for (const block of String(srt ?? "").replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const [rawStart, rawEnd] = timeLine.split("-->");
    const start = parseSrtSeconds(rawStart);
    const end = parseSrtSeconds(rawEnd);
    if (start == null || end == null) continue;
    const text = lines
      .slice(lines.indexOf(timeLine) + 1)
      .join(" ")
      .trim();
    if (!text) continue;
    cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function parseSrtSeconds(raw) {
  const m = String(raw ?? "").trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000;
}

// ---------------------------------------------------------------------------
// Scene cuts — the AI may keep several source ranges inside a clip window and
// skip what it judged boring in between (clip_intel edit list). These helpers
// sanitize that list against the clip window and re-time clip-local caption
// / b-roll windows onto the merged (output) timeline, where removed material
// collapses. Everything here is pure so the render pipeline stays testable.
// ---------------------------------------------------------------------------

/** Total removed seconds across the sanitized cut list. */
function segmentsRemovedSec(segments, winStart, winEnd) {
  const kept = segments.reduce((s, seg) => s + (seg.end - seg.start), 0);
  return Math.max(0, winEnd - winStart - kept);
}

/**
 * Validate + normalize an edit decision list (absolute source seconds) against
 * the clip window [winStart, winEnd]:
 * - coerces numbers, clamps to the window, drops inverted/empty ranges,
 * - sorts, resolves overlaps by clipping later segments,
 * - merges ranges separated by less than MERGE_GAP (sub-perceptual cuts),
 * - returns null when the list is unusable or cuts so little that rendering
 *   the contiguous window is indistinguishable (keeps old clips byte-stable).
 */
export function sanitizeSegments(rawSegments, winStart, winEnd, { minTotalCut = 1.0, mergeGap = 0.5 } = {}) {
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) return null;
  if (!(Number.isFinite(winStart) && Number.isFinite(winEnd)) || winEnd - winStart < 3) return null;

  let ranges = rawSegments
    .map((s) => ({ start: Number(s?.start), end: Number(s?.end) }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end - s.start > 0.2)
    .map((s) => ({
      start: Math.min(winEnd, Math.max(winStart, s.start)),
      end: Math.min(winEnd, Math.max(winStart, s.end)),
    }))
    .filter((s) => s.end - s.start > 0.2)
    .sort((a, b) => a.start - b.start);

  // Resolve overlaps / touching ranges by extending the earlier one.
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + mergeGap) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  ranges = merged;

  if (ranges.length === 0) return null;
  // A single range that covers the whole window is a no-op; a single shorter
  // range is just a trim — both are below "the AI skipped a scene" territory
  // only when almost nothing was removed, in which case skip the cutting.
  if (segmentsRemovedSec(ranges, winStart, winEnd) < minTotalCut) return null;
  if (ranges.reduce((s, r) => s + (r.end - r.start), 0) < 3) return null;
  return ranges;
}

/**
 * Map one clip-local time onto the merged (output) timeline. Times inside a
 * removed gap collapse to the end of the previous kept range (the exact
 * cut point), so captions land at the seam instead of drifting.
 */
function clipLocalToOutput(t, segments, clipStart) {
  let out = 0;
  for (const seg of segments) {
    const s = Math.max(0, seg.start - clipStart);
    const e = Math.max(0, seg.end - clipStart);
    if (t < s) return out; // inside the gap before this segment -> seam
    if (t <= e) return out + (t - s);
    out += e - s;
  }
  return out;
}

/**
 * Re-time caption cues (clip-local, built against the contiguous window) onto
 * the merged output timeline. Cues that fall entirely inside a removed gap are
 * dropped; cues that straddle a cut are clamped to the seam. Word timings are
 * remapped with the same rule (words inside the gap are dropped).
 */
export function remapCuesToSegments(cues, segments, clipStart) {
  if (!Array.isArray(cues) || !Array.isArray(segments) || segments.length === 0) return cues ?? [];
  const out = [];
  for (const cue of cues) {
    const start = clipLocalToOutput(Number(cue.start), segments, clipStart);
    const end = clipLocalToOutput(Number(cue.end), segments, clipStart);
    if (end - start < 0.15) continue; // entirely (or almost) inside a removed gap

    const words = Array.isArray(cue.words)
      ? cue.words
          .map((w) => ({
            ...w,
            start: clipLocalToOutput(Number(w.start), segments, clipStart),
            end: clipLocalToOutput(Number(w.end), segments, clipStart),
          }))
          .filter((w) => w.end - w.start > 0.02)
      : undefined;

    out.push({
      ...cue,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      ...(words ? { words } : {}),
    });
  }
  return out;
}

/**
 * Re-time a b-roll / overlay window (clip-local [start, end]) onto the merged
 * output timeline. Returns null when the window falls entirely inside removed
 * material; straddling windows are clamped to the seam (shortened, never
 * stretched). The stock clip's own seek offset is not touched — only where it
 * appears on the output timeline.
 */
export function remapWindowToSegments(start, end, segments, clipStart) {
  if (!Array.isArray(segments) || segments.length === 0) return { start, end };
  const s = clipLocalToOutput(Number(start), segments, clipStart);
  const e = clipLocalToOutput(Number(end), segments, clipStart);
  if (e - s < 0.3) return null;
  return { start: Math.round(s * 1000) / 1000, end: Math.round(e * 1000) / 1000 };
}
