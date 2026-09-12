"use client";

import {
  app,
  auth,
  firestore,
  onAuthStateChanged,
} from "@/lib/firebase";
import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as fbSignOut,
} from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit as fsLimit,
  onSnapshot,
  orderBy as fsOrderBy,
  query as fsQuery,
  setDoc,
  where,
} from "firebase/firestore";

/**
 * Supabase-compatible browser client backed by Firebase.
 *
 * Auth maps to Firebase Auth; the query API maps to Firestore with the same
 * supabase-js builder surface (from/select/eq/order/limit/single, realtime
 * channels, insert/update). Firestore security rules replace RLS: every
 * user-scoped collection is automatically constrained to the signed-in
 * user's rows, so page queries that relied on RLS filtering keep working.
 */

// Collections where RLS filtered rows by user_id — the shim injects that
// filter client-side so Firestore security rules (which require it in the
// query itself) are satisfied.
const USER_SCOPED = new Set([
  "projects",
  "clips",
  "jobs",
  "scheduled_posts",
  "social_connections",
  "feedback",
  "upgrade_requests",
]);

type EqFilter = { field: string; value: unknown };

function embedPaths(selectStr: string | undefined) {
  if (!selectStr) return [] as { relation: string; arg: string }[];
  const out: { relation: string; arg: string }[] = [];
  for (const part of selectStr.split(",").map((s) => s.trim())) {
    const m = part.match(/^([a-zA-Z0-9_]+)\((.*)\)$/);
    if (m) out.push({ relation: m[1], arg: m[2].trim() });
  }
  return out;
}

class ClientQuery {
  table: string;
  filters: EqFilter[] = [];
  orders: { field: string; ascending: boolean }[] = [];
  limitN: number | null = null;
  selectStr = "*";
  countMode: string | null = null;
  head = false;
  singleMode: string | null = null;
  mutation: { type: string; payload?: unknown } | null = null;

  constructor(table: string) {
    this.table = table;
  }

  select(selectStr: string = "*", opts?: { count?: string; head?: boolean }) {
    this.selectStr = selectStr;
    if (opts?.count) this.countMode = opts.count;
    if (opts?.head) this.head = true;
    return this;
  }

  eq(field: string, value: unknown) {
    this.filters.push({ field, value });
    return this;
  }

  order(field: string, opts: { ascending?: boolean } = {}) {
    this.orders.push({ field, ascending: opts.ascending !== false });
    return this;
  }

  limit(n: number) {
    this.limitN = n;
    return this;
  }

  single() {
    this.singleMode = "single";
    return this;
  }

  maybeSingle() {
    this.singleMode = "maybeSingle";
    return this;
  }

  insert(payload: unknown) {
    this.mutation = { type: "insert", payload };
    return this;
  }

  update(patch: unknown) {
    this.mutation = { type: "update", payload: patch };
    return this;
  }

  private scopedFilters(uid: string): EqFilter[] {
    if (!USER_SCOPED.has(this.table)) return this.filters;
    const hasUser = this.filters.some((f) => f.field === "user_id");
    if (hasUser) return this.filters;
    return [...this.filters, { field: "user_id", value: uid }];
  }

  private buildQuery(uid: string) {
    const constraints: unknown[] = [];
    for (const f of this.scopedFilters(uid)) {
      constraints.push(where(f.field, "==", f.value));
    }
    for (const o of this.orders) {
      constraints.push(fsOrderBy(o.field, o.ascending ? "asc" : "desc"));
    }
    if (this.limitN != null) constraints.push(fsLimit(this.limitN));
    return fsQuery(collection(firestore, this.table), ...(constraints as never[]));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async applyEmbeds(rows: any[], uid: string): Promise<any> {
    for (const { relation, arg } of embedPaths(this.selectStr)) {
      if (arg !== "count") continue;
      // children count via <relation>.<parent-singular>_id == row.id
      const fk = `${relation.replace(/s$/, "")}_id`;
      for (const row of rows) {
        const snap = await getDocs(
          fsQuery(
            collection(firestore, relation),
            where(fk, "==", row.id),
            where("user_id", "==", uid)
          )
        );
        row[relation] = [{ count: snap.size }];
      }
    }
    return rows;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async _run(): Promise<any> {
    const user = auth.currentUser;
    const uid = user?.uid ?? "";

    if (this.mutation) return this._runMutation(uid);

    // Count-only query (e.g. analytics headline numbers).
    if (this.countMode && this.head) {
      const snap = await getDocs(this.buildQuery(uid)!);
      return { data: null, error: null, count: snap.size };
    }

    // profiles: single doc per uid
    if (this.table === "profiles") {
      const idFilter = this.filters.find((f) => f.field === "id");
      const target = idFilter ? idFilter.value : uid;
      const snap = await getDoc(doc(firestore, "profiles", String(target)));
      const row = snap.exists() ? { id: snap.id, ...snap.data() } : null;
      if (this.singleMode && !row) {
        return { data: null, error: { code: "PGRST116", message: "0 rows" } };
      }
      return { data: row, error: null };
    }

    const snap = await getDocs(this.buildQuery(uid)!);
    let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    rows = await this.applyEmbeds(rows, uid);

    if (this.singleMode) {
      if (rows.length === 0) {
        return { data: null, error: { code: "PGRST116", message: "0 rows" } };
      }
      return { data: rows[0], error: null };
    }
    return { data: rows, error: null };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async _runMutation(uid: string): Promise<any> {
    const { type, payload } = this.mutation!;
    try {
      if (type === "insert") {
        const row = { ...(payload as Record<string, unknown>) };
        if (USER_SCOPED.has(this.table)) row.user_id = row.user_id ?? uid;
        if (this.table === "profiles") {
          await setDoc(doc(firestore, "profiles", uid), {
            id: uid,
            email: auth.currentUser?.email ?? null,
            created_at: new Date().toISOString(),
            ...row,
          }, { merge: true });
          return { data: { id: uid, ...row }, error: null };
        }
        const ref = doc(collection(firestore, this.table));
        await setDoc(ref, {
          created_at: new Date().toISOString(),
          ...row,
        });
        return { data: { id: ref.id, ...row }, error: null };
      }

      if (type === "update") {
        const patch = payload as Record<string, unknown>;
        if (this.table === "profiles") {
          await setDoc(doc(firestore, "profiles", uid), patch, { merge: true });
          return { data: { id: uid, ...patch }, error: null };
        }
        // Update only rows visible to the user.
        const snap = await getDocs(this.buildQuery(uid)!);
        for (const d of snap.docs) {
          await setDoc(d.ref, patch, { merge: true });
        }
        return { data: snap.docs.map((d) => ({ id: d.id, ...patch })), error: null };
      }
    } catch (e) {
      return {
        data: null,
        error: { message: e instanceof Error ? e.message : "write failed" },
      };
    }
  }

  then(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onFulfilled?: (v: any) => any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onRejected?: (e: any) => any
  ) {
    return this._run().then(onFulfilled, onRejected);
  }
}

function createClient() {
  return {
    auth: {
      async getUser() {
        const user = auth.currentUser;
        if (!user) {
          // Wait briefly for Firebase to restore the session from storage.
          const waited = await new Promise((resolve) => {
            const t = setTimeout(() => resolve(null), 1500);
            const unsub = onAuthStateChanged(auth, (u) => {
              if (u) {
                clearTimeout(t);
                unsub();
                resolve(u);
              }
            });
          });
          if (!waited) return { data: { user: null }, error: null };
        }
        const u = auth.currentUser!;
        const claims = (await u.getIdTokenResult()).claims;
        return {
          data: {
            user: {
              id: u.uid,
              email: u.email ?? "",
              user_metadata: {
                full_name: u.displayName,
                avatar_url: u.photoURL,
                name: u.displayName,
              },
              admin: claims.admin === true,
            },
          },
          error: null,
        };
      },

      async getSession() {
        const user = auth.currentUser;
        if (!user) return { data: { session: null }, error: null };
        const token = await user.getIdToken();
        return {
          data: {
            session: {
              access_token: token,
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              user: { id: user.uid, email: user.email ?? "" },
            },
          },
          error: null,
        };
      },

      async refreshSession() {
        const user = auth.currentUser;
        if (!user) return { data: { session: null }, error: null };
        const token = await user.getIdToken(true);
        return {
          data: {
            session: {
              access_token: token,
              expires_at: Math.floor(Date.now() / 1000) + 3600,
            },
          },
          error: null,
        };
      },

      async signUp({ email, password }: { email: string; password: string }) {
        try {
          await createUserWithEmailAndPassword(auth, email, password);
          return { data: { user: auth.currentUser }, error: null };
        } catch (e) {
          return {
            data: { user: null },
            error: { message: e instanceof Error ? e.message : "Sign up failed" },
          };
        }
      },

      async signInWithPassword({ email, password }: { email: string; password: string }) {
        try {
          await signInWithEmailAndPassword(auth, email, password);
          return { data: { user: auth.currentUser }, error: null };
        } catch (e) {
          return {
            data: { user: null },
            error: { message: e instanceof Error ? e.message : "Sign in failed" },
          };
        }
      },

      async signInWithOAuth(
        { provider }: { provider: string; options?: unknown },
        _options?: unknown
      ) {
        if (provider !== "google") {
          return { data: { provider }, error: { message: `Unsupported provider: ${provider}` } };
        }
        try {
          await signInWithPopup(auth, new GoogleAuthProvider());
          return { data: { provider }, error: null };
        } catch (e) {
          return {
            data: { provider },
            error: { message: e instanceof Error ? e.message : "Google sign in failed" },
          };
        }
      },

      async updateUser({ password, data }: { password?: string; data?: Record<string, unknown> }) {
        try {
          const user = auth.currentUser;
          if (!user) return { data: { user: null }, error: { message: "Not signed in" } };
          if (password) {
            const { updatePassword } = await import("firebase/auth");
            await updatePassword(user, password);
          }
          if (data) {
            const profile: Record<string, unknown> = { ...data };
            if (typeof data.display_name === "string") profile.display_name = data.display_name;
            await setDoc(doc(firestore, "profiles", user.uid), profile, { merge: true });
          }
          return { data: { user }, error: null };
        } catch (e) {
          const message =
            e instanceof Error && /recent-login|requires-recent-login/i.test(e.message)
              ? "Please sign out and sign in again before changing your password"
              : e instanceof Error
                ? e.message
                : "Update failed";
          return { data: { user: null }, error: { message } };
        }
      },

      async signOut() {
        await fbSignOut(auth);
        return { error: null };
      },

      onAuthStateChanged(cb: (user: { id: string; email: string } | null) => void) {
        return onAuthStateChanged(auth, (u) =>
          cb(u ? { id: u.uid, email: u.email ?? "" } : null)
        );
      },
    },

    from(table: string) {
      return new ClientQuery(table);
    },

    channel(name: string) {
      const listeners: { table: string; cb: () => void }[] = [];
      const unsubs: (() => void)[] = [];
      return {
        on(
          _event: string,
          opts: { table?: string; event?: string; schema?: string; filter?: unknown },
          cb: () => void
        ) {
          if (opts?.table) listeners.push({ table: opts.table, cb });
          return this;
        },
        subscribe() {
          const user = auth.currentUser;
          const uid = user?.uid;
          for (const { table, cb } of listeners) {
            if (!uid || !USER_SCOPED.has(table)) {
              unsubs.push(onSnapshot(collection(firestore, table), () => cb()));
              continue;
            }
            unsubs.push(
              onSnapshot(
                fsQuery(collection(firestore, table), where("user_id", "==", uid)),
                () => cb()
              )
            );
          }
          return this;
        },
        remove() {
          unsubs.forEach((u) => u());
          unsubs.length = 0;
          return Promise.resolve("ok");
        },
      };
    },

    removeChannel(channel: { remove?: () => Promise<string> }) {
      return channel.remove?.() ?? Promise.resolve("ok");
    },
  };
}

export { createClient };
export default createClient;
