"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";

/**
 * Mount-time entrance for dashboard content — unlike the landing FadeIn it
 * doesn't wait for scroll, so above-the-fold pages still animate.
 */
export function Reveal({
  children,
  delay = 0,
  y = 16,
  className,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay, ease: [0.21, 0.47, 0.32, 0.98] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
