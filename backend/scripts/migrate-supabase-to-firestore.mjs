/**
 * One-shot migration: Supabase (Postgres + Auth) → Firebase (Firestore + Auth).
 *
 * Usage (run from backend/, needs SUPABASE creds only while they still exist):
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   FIREBASE_SERVICE_ACCOUNT="$(cat service-account.json)" \
 *   node scripts/migrate-supabase-to-firestore.mjs
 *
 * What it does:
 *  1. Exports every table from Supabase via the REST API.
 *  2. Creates Firebase Auth users (email/password users are imported with
 *     their bcrypt hashes so passwords keep working; Google-only users are
 *     created without one).
 *  3. Maps old uuids → new Firebase uids, rewrites user_id/owner columns,
 *     and writes all rows into Firestore collections named after the tables.
 *  4. Stamps admin custom claims for the ADMIN_EMAILS allowlist.
 *
 * Idempotent: re-running re-imports the same tables (merge), but does not
 * duplicate auth users (skips emails that already exist in Firebase).
 */

import { initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!SUPABASE_URL || !SUPABASE_KEY || !raw) {
  console.error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and FIREBASE_SERVICE_ACCOUNT are all required");
  process.exit(1);
}
const serviceAccount = JSON.parse(
  raw.trimStart().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")
);

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const fbAuth = getAuth();

const TABLES = [
  "profiles",
  "projects",
  "clips",
  "jobs",
  "scheduled_posts",
  "social_connections",
  "upgrade_requests",
  "pricing_plans",
  "feedback",
  "app_branding",
];

const OWNER_COL = new Set([
  "profiles",
  "projects",
  "clips",
  "jobs",
  "scheduled_posts",
  "social_connections",
  "upgrade_requests",
  "feedback",
]);

async function exportTable(table) {
  const rows = [];
  let from = 0;
  const pageSize = 1000;
  for (;;) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?select=*&order=id&limit=${pageSize}&offset=${from}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function exportAuthUsers() {
  const users = [];
  let page = 1;
  for (;;) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=200`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) throw new Error(`auth users: ${res.status}`);
    const body = await res.json();
    users.push(...(body.users ?? []));
    if (!body.users?.length || (body.users?.length ?? 0) < 200) break;
    page += 1;
  }
  return users;
}

async function main() {
  console.log("[1/5] exporting Supabase auth users…");
  const authUsers = await exportAuthUsers();
  console.log(`  ${authUsers.length} users`);

  console.log("[2/5] creating Firebase users (skips existing emails)…");
  const uidMap = new Map(); // old uuid -> new uid
  const toImport = [];
  for (const u of authUsers) {
    const email = (u.email ?? "").toLowerCase();
    if (!email) continue;
    try {
      const existing = await fbAuth.getUserByEmail(email);
      uidMap.set(u.id, existing.uid);
      continue;
    } catch {
      /* not found — import below */
    }
    toImport.push(u);
  }

  if (toImport.length) {
    // Supabase stores bcrypt hashes; Firebase can import them directly.
    const result = await fbAuth.importUsers(
      toImport.map((u) => ({
        uid: u.id, // reuse the uuid as uid — keeps every foreign key valid
        email: u.email,
        emailVerified: !!u.email_confirmed_at || !!u.confirmed_at,
        displayName:
          u.raw_user_meta_data?.full_name ?? u.raw_user_meta_data?.name ?? undefined,
        photoURL: u.raw_user_meta_data?.avatar_url ?? undefined,
        ...(u.encrypted_password
          ? {
              passwordHash: Buffer.from(u.encrypted_password, "base64"),
              passwordSalt: Buffer.alloc(0),
            }
          : {}),
      })),
      { hash: { algorithm: "BCRYPT" } }
    );
    for (const u of toImport) uidMap.set(u.id, u.id);
    if (result.errors.length) {
      console.error("  import errors:", result.errors);
    }
  }
  console.log(`  mapped ${uidMap.size} users`);

  console.log("[3/5] stamping admin claims…");
  const adminEmails = (process.env.ADMIN_EMAILS ?? "pencilmacro@gmail.com,taratip.pae@gmail.com")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  for (const email of adminEmails) {
    try {
      const user = await fbAuth.getUserByEmail(email);
      await fbAuth.setCustomUserClaims(user.uid, { admin: true });
    } catch {
      console.warn(`  admin email not found in Firebase: ${email}`);
    }
  }

  console.log("[4/5] exporting tables…");
  const data = {};
  for (const table of TABLES) {
    data[table] = await exportTable(table);
    console.log(`  ${table}: ${data[table].length} rows`);
  }

  console.log("[5/5] importing into Firestore…");
  const batch = db.batch();
  let ops = 0;
  const commit = async () => {
    if (ops) {
      await batch.commit();
      ops = 0;
    }
  };
  const add = (ref, docData) => {
    batch.set(ref, docData, { merge: true });
    if (++ops >= 450) return commit();
  };

  for (const table of TABLES) {
    const keyedBy = table === "app_branding" ? "key" : null;
    for (const row of data[table]) {
      const doc = { ...row };
      if (keyedBy) {
        // app_branding keyed by its `key` column
        const key = doc[keyedBy];
        add(db.collection(table).doc(String(key)), doc);
        continue;
      }
      if (table === "profiles") {
        const newId = uidMap.get(doc.id) ?? doc.id;
        doc.id = newId;
        add(db.collection(table).doc(newId), doc);
        continue;
      }
      if (OWNER_COL.has(table) && uidMap.has(doc.user_id)) {
        doc.user_id = uidMap.get(doc.user_id);
      }
      if (uidMap.size && doc.id) {
        // keep original row uuid as doc id so old links keep working
        add(db.collection(table).doc(String(doc.id)), doc);
      } else {
        add(db.collection(table).doc(), doc);
      }
    }
  }
  await commit();
  console.log("done ✔");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
