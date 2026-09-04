/**
 * Client-side SRT parsing/formatting for the clip editor.
 */

export interface SrtCue {
  id: string;
  start: number;
  end: number;
  text: string;
}

function parseTimestamp(raw: string): number | null {
  const m = raw.trim().match(/^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return null;
  return (
    Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0")) / 1000
  );
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, seconds);
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 1000);
  const pad = (n: number, len = 2) => n.toString().padStart(len, "0");
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)},${pad(ms, 3)}`;
}

/** Parse SRT text into cues. Unparseable blocks are skipped. */
export function parseSrt(srt: string): SrtCue[] {
  const cues: SrtCue[] = [];
  const blocks = srt.replace(/\r/g, "").split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    const timeLineIndex = lines.findIndex((l) => l.includes("-->"));
    if (timeLineIndex === -1) continue;
    const [rawStart, rawEnd] = lines[timeLineIndex].split("-->");
    const start = parseTimestamp(rawStart ?? "");
    const end = parseTimestamp(rawEnd ?? "");
    if (start == null || end == null) continue;
    const text = lines
      .slice(timeLineIndex + 1)
      .join(" ")
      .trim();
    if (!text) continue;
    cues.push({ id: crypto.randomUUID(), start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** Serialize cues back to SRT text. */
export function cuesToSrtText(cues: SrtCue[]): string {
  return cues
    .map(
      (cue, i) =>
        `${i + 1}\n${formatTimestamp(cue.start)} --> ${formatTimestamp(
          Math.max(cue.end, cue.start + 0.3)
        )}\n${cue.text}\n`
    )
    .join("\n");
}

export function secondsToDisplay(seconds: number): string {
  return formatTimestamp(seconds);
}
