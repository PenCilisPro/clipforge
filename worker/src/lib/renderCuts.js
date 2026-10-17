/**
 * Builds an ffmpeg filter_complex that keeps only clip.segments and joins them.
 * Use with input seeking so ffmpeg only decodes the clip's range:
 *
 *   const { filter, v, a } = buildCutFilter(clip.segments, { offset: clip.start, fps: 30 });
 *   ffmpeg -ss <clip.start> -t <clip.end - clip.start> -i source.mp4
 *          -filter_complex "<filter>" -map "<v>" -map "<a>" ... out.mp4
 *
 * To crop or scale, chain onto the video label, e.g. `${filter};${v}crop=ih*9/16:ih[vout]`.
 */
export function buildCutFilter(segments, { offset = 0, fps = 30, fade = 0.012, videoIn = "0:v", audioIn = "0:a" } = {}) {
  const snap = (t) => Math.max(0, Math.round((t - offset) * fps) / fps); // frame grid stops A/V drift across cuts
  const parts = [];
  const pairs = [];
  segments.forEach((seg, i) => {
    const s = snap(seg.start);
    const e = Math.max(s + 1 / fps, snap(seg.end));
    const d = e - s;
    const f = Math.min(fade, d / 4);
    parts.push(`[${videoIn}]trim=start=${s.toFixed(4)}:end=${e.toFixed(4)},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(
      `[${audioIn}]atrim=start=${s.toFixed(4)}:end=${e.toFixed(4)},asetpts=PTS-STARTPTS,` +
      `afade=t=in:st=0:d=${f.toFixed(4)},afade=t=out:st=${(d - f).toFixed(4)}:d=${f.toFixed(4)}[a${i}]`
    );
    pairs.push(`[v${i}][a${i}]`);
  });
  parts.push(`${pairs.join("")}concat=n=${segments.length}:v=1:a=1[vcut][acut]`);
  return { filter: parts.join(";"), v: "[vcut]", a: "[acut]" };
}