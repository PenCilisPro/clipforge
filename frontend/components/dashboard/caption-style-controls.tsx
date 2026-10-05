"use client";

import { AnimatedCaptionPreview, CaptionPreview } from "@/components/dashboard/caption-preview";
import { Label } from "@/components/ui/label";
import {
  CAPTION_FONTS,
  CAPTION_STYLES,
  type CaptionFontKey,
  type CaptionStyle,
  type VideoFit,
} from "@/lib/types";
import { cn } from "@/lib/utils";

export interface CaptionStyleValue {
  caption_style: CaptionStyle;
  caption_font: CaptionFontKey;
  /** '#ffffff' keeps the template's own default text color. */
  caption_color: string;
  caption_stroke: boolean;
  caption_stroke_color: string;
  caption_stroke_size: number;
  caption_shadow: boolean;
  caption_shadow_color: string;
  caption_shadow_size: number;
  /** 9:16 layout for landscape sources: "cover" = zoomed fill (cropped). */
  video_fit: VideoFit;
  /** With video_fit "contain": blurred zoomed background instead of black bars. */
  video_background_blur: boolean;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyleValue = {
  caption_style: "karaoke",
  caption_font: "anton",
  caption_color: "#ffffff",
  caption_stroke: false,
  caption_stroke_color: "#000000",
  caption_stroke_size: 4,
  caption_shadow: false,
  caption_shadow_color: "#000000",
  caption_shadow_size: 6,
  video_fit: "cover",
  video_background_blur: true,
};

const VIDEO_FIT_OPTIONS: { key: VideoFit; label: string; description: string }[] = [
  { key: "cover", label: "Zoom to fill", description: "Fills the frame — sides are cropped" },
  { key: "contain", label: "Original size", description: "Whole video visible" },
];

/** Miniature 9:16 mock of how a 16:9 source lands on the vertical canvas. */
function LayoutThumb({ fit, blur }: { fit: VideoFit; blur: boolean }) {
  const gradient = "bg-[linear-gradient(135deg,#64748b,#1e293b_55%,#475569)]";
  return (
    <div className="relative mx-auto aspect-[9/16] w-14 overflow-hidden rounded border bg-black">
      {fit === "contain" && blur && (
        <div className={cn("absolute inset-0 scale-150 blur-[3px]", gradient)} />
      )}
      <div
        className={cn(
          gradient,
          fit === "cover"
            ? "absolute inset-0"
            : "absolute inset-x-0 top-1/2 aspect-video -translate-y-1/2"
        )}
      />
    </div>
  );
}

/**
 * Full caption look controls: template, font, text color, stroke and shadow,
 * with a live word-sync preview. Used on the New Project page (defaults
 * applied to every clip) and in the clip editor (per-clip overrides).
 */
export function CaptionStyleControls({
  value,
  onChange,
}: {
  value: CaptionStyleValue;
  onChange: (patch: Partial<CaptionStyleValue>) => void;
}) {
  const {
    caption_style: style,
    caption_font: font,
    caption_color: textColor,
    caption_stroke: stroke,
    caption_stroke_color: strokeColor,
    caption_stroke_size: strokeSize,
    caption_shadow: shadow,
    caption_shadow_color: shadowColor,
    caption_shadow_size: shadowSize,
    video_fit: videoFit,
    video_background_blur: blur,
  } = value;
  const customColor = textColor.toLowerCase() !== "#ffffff";

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label className="text-xs">Video layout (16:9 → 9:16)</Label>
        <div className="grid grid-cols-2 gap-2">
          {VIDEO_FIT_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => onChange({ video_fit: option.key })}
              className={cn(
                "rounded-lg border p-2 text-center transition-all hover:border-primary-500/60",
                videoFit === option.key && "border-primary-500 ring-2 ring-primary-500/30"
              )}
            >
              <LayoutThumb fit={option.key} blur={blur} />
              <p className="mt-1.5 text-xs font-semibold">{option.label}</p>
              <p className="text-[11px] leading-tight text-muted-foreground">
                {option.description}
              </p>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            id="video-background-blur"
            checked={blur}
            onChange={(e) => onChange({ video_background_blur: e.target.checked })}
            disabled={videoFit !== "contain"}
            className="h-3.5 w-3.5 accent-[var(--primary)] disabled:opacity-40"
          />
          <Label htmlFor="video-background-blur" className="text-xs font-medium">
            Blurred background
          </Label>
          <span className="text-muted-foreground">off = black bars</span>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Live preview</Label>
        <AnimatedCaptionPreview
          style={style}
          fontKey={font}
          textColor={textColor}
          stroke={stroke}
          shadow={shadow}
          strokeColor={strokeColor}
          strokeSize={strokeSize}
          shadowColor={shadowColor}
          shadowSize={shadowSize}
        />
        <p className="text-xs text-muted-foreground">
          The accented word follows the voice — exactly what the render produces.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Text template</Label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {CAPTION_STYLES.map((tpl) => (
            <button
              key={tpl.key}
              type="button"
              onClick={() => onChange({ caption_style: tpl.key })}
              className={cn(
                "rounded-lg border p-1.5 text-left transition-all hover:border-primary-500/60",
                style === tpl.key && "border-primary-500 ring-2 ring-primary-500/30"
              )}
            >
              <CaptionPreview
                style={tpl.key}
                fontKey={font}
                textColor={textColor}
                stroke={stroke}
                shadow={shadow}
                strokeColor={strokeColor}
                strokeSize={strokeSize}
                shadowColor={shadowColor}
                shadowSize={shadowSize}
              />
              <p className="mt-1.5 text-xs font-semibold">{tpl.label}</p>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {CAPTION_STYLES.find((s) => s.key === style)?.description}
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Font</Label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {CAPTION_FONTS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => onChange({ caption_font: option.key })}
              style={{ fontFamily: option.cssVar }}
              className={cn(
                "truncate rounded-lg border px-2 py-2 text-sm transition-all hover:border-primary-500/60",
                font === option.key && "border-primary-500 ring-2 ring-primary-500/30"
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            id="caption-custom-color"
            checked={customColor}
            onChange={(e) => onChange({ caption_color: e.target.checked ? "#ff5d1c" : "#ffffff" })}
            className="h-3.5 w-3.5 accent-[var(--primary)]"
          />
          <Label htmlFor="caption-custom-color" className="text-xs font-medium">
            Text color
          </Label>
          <input
            type="color"
            value={customColor ? textColor : "#ffffff"}
            onChange={(e) => onChange({ caption_color: e.target.value })}
            disabled={!customColor}
            aria-label="Text color"
            className="h-6 w-8 cursor-pointer rounded border bg-transparent p-0.5 disabled:opacity-40"
          />
          <span className="text-muted-foreground">off = template default</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            id="caption-stroke"
            checked={stroke}
            onChange={(e) => onChange({ caption_stroke: e.target.checked })}
            className="h-3.5 w-3.5 accent-[var(--primary)]"
          />
          <Label htmlFor="caption-stroke" className="text-xs font-medium">
            Stroke
          </Label>
          <input
            type="color"
            value={strokeColor}
            onChange={(e) => onChange({ caption_stroke_color: e.target.value })}
            disabled={!stroke}
            aria-label="Stroke color"
            className="h-6 w-8 cursor-pointer rounded border bg-transparent p-0.5 disabled:opacity-40"
          />
          <input
            type="range"
            min={1}
            max={10}
            value={strokeSize}
            onChange={(e) => onChange({ caption_stroke_size: Number(e.target.value) })}
            disabled={!stroke}
            aria-label="Stroke size"
            className="h-1 flex-1 accent-[var(--primary)] disabled:opacity-40"
          />
          <span className="w-4 text-right tabular-nums">{strokeSize}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            id="caption-shadow"
            checked={shadow}
            onChange={(e) => onChange({ caption_shadow: e.target.checked })}
            className="h-3.5 w-3.5 accent-[var(--primary)]"
          />
          <Label htmlFor="caption-shadow" className="text-xs font-medium">
            Shadow
          </Label>
          <input
            type="color"
            value={shadowColor}
            onChange={(e) => onChange({ caption_shadow_color: e.target.value })}
            disabled={!shadow}
            aria-label="Shadow color"
            className="h-6 w-8 cursor-pointer rounded border bg-transparent p-0.5 disabled:opacity-40"
          />
          <input
            type="range"
            min={1}
            max={10}
            value={shadowSize}
            onChange={(e) => onChange({ caption_shadow_size: Number(e.target.value) })}
            disabled={!shadow}
            aria-label="Shadow size"
            className="h-1 flex-1 accent-[var(--primary)] disabled:opacity-40"
          />
          <span className="w-4 text-right tabular-nums">{shadowSize}</span>
        </div>
      </div>
    </div>
  );
}
