import {
  Clapperboard,
  Crown,
  Flame,
  Gem,
  Heart,
  Layers,
  Play,
  Rocket,
  Sparkles,
  Star,
  Video,
  Zap,
  type LucideIcon,
} from "lucide-react";

/** Icon options for pricing plans — keys persist in pricing_plans.icon. */
export const PLAN_ICONS: Record<string, LucideIcon> = {
  sparkles: Sparkles,
  zap: Zap,
  rocket: Rocket,
  crown: Crown,
  gem: Gem,
  star: Star,
  flame: Flame,
  heart: Heart,
  clapperboard: Clapperboard,
  video: Video,
  play: Play,
  layers: Layers,
};

export const PLAN_ICON_KEYS = Object.keys(PLAN_ICONS);

export function planIcon(name: string | null | undefined): LucideIcon {
  return (name && PLAN_ICONS[name]) || Sparkles;
}
