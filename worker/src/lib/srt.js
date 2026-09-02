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
        text: current.words.join(" "),
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
    current.words.push(text);
    current.end = wEnd;

    const chars = current.words.join(" ").length;
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
