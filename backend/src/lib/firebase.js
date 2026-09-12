import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, Filter, FieldValue } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";
import { env } from "../config/env.js";

/**
 * Firebase Admin bootstrap (Firestore). Credentials come from
 * FIREBASE_SERVICE_ACCOUNT — either the raw service-account JSON, a base64
 * encoding of it, or a path to the .json file.
 */
function initAdmin() {
  if (getApps().length) return getApps()[0];
  const raw = env.firebaseServiceAccount;
  if (!raw) {
    // Degraded mode: API still boots so health checks pass, but Firestore
    // calls will fail. Mirrors the old missing-SUPABASE_* behaviour.
    return initializeApp({ projectId: env.firebaseProjectId ?? "missing" });
  }
  let json = raw;
  if (!raw.trimStart().startsWith("{")) {
    try {
      json = Buffer.from(raw, "base64").toString("utf8");
    } catch {
      json = raw;
    }
  }
  let creds;
  try {
    creds = JSON.parse(json);
  } catch {
    creds = JSON.parse(readFileSync(json, "utf8"));
  }
  return initializeApp({
    credential: cert(creds),
    projectId: env.firebaseProjectId ?? creds.project_id,
  });
}

let _db;
export function db() {
  if (!_db) {
    initAdmin();
    _db = getFirestore();
  }
  return _db;
}

export { Filter, FieldValue };
