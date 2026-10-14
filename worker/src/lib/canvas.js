/**
 * Output canvas geometry shared by every render provider. The clip editor's
 * PLATFORM control picks the aspect; providers translate it to their own
 * width/height fields. Keep the dimensions multiples of 16 (x264-friendly)
 * and matched to the historical 1080x1920 default.
 */
const ASPECT_DIMENSIONS = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
};

export function aspectDimensions(aspect) {
  return ASPECT_DIMENSIONS[aspect] ?? ASPECT_DIMENSIONS["9:16"];
}
