/**
 * Transcript helpers — convert word-level Speech-to-Text output into
 * SRT captions and Shotstack caption-friendly data.
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
