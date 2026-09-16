"use client";

import { useEffect } from "react";

/**
 * Firestore (firebase 12.x) throws "INTERNAL ASSERTION FAILED: Unexpected
 * state (ID: a5xx)" from inside its listener transport when a WebChannel
 * stream is torn down mid-handshake (firebase-js-sdk#6907, #7731). The
 * rejection escapes as an unhandled promise rejection and crashes the React
 * tree even though Firestore itself recovers by restarting the listener.
 * This guard marks exactly those internal-assertion rejections as handled so
 * the rest of the page keeps working; real errors still propagate.
 */
export function FirestoreCrashGuard() {
  useEffect(() => {
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message =
        typeof reason?.message === "string" ? reason.message : String(reason ?? "");
      if (/INTERNAL ASSERTION FAILED: Unexpected state/.test(message)) {
        event.preventDefault();
      }
    };
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => window.removeEventListener("unhandledrejection", onUnhandledRejection);
  }, []);

  return null;
}
