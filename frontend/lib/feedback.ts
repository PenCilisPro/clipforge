export const FEEDBACK_CATEGORIES = [
  { value: "general", label: "General" },
  { value: "bug_report", label: "Bug report" },
  { value: "feature_request", label: "Feature request" },
  { value: "billing", label: "Billing" },
] as const;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]["value"];

export function categoryLabel(value: string | null | undefined): string {
  return FEEDBACK_CATEGORIES.find((c) => c.value === value)?.label ?? "General";
}
