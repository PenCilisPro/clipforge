import { randomUUID } from "node:crypto";
import { db } from "./firebase.js";

/**
 * Supabase-compatible query shim over Cloud Firestore.
 *
 * The codebase was written against supabase-js (`from().select().eq()...`).
 * Rather than rewriting ~40 call sites, this shim implements the subset of
 * that API the app actually uses, backed by Firestore collections named
 * after the old tables. Backend + worker only — it runs with admin
 * credentials and bypasses Firestore security rules (like the old
 * service-role key bypassed RLS).
 *
 * Supported: select (incl. count + single-relation embeds), eq, neq, gt, gte,
 * lt, lte, in, is, not, or (with nested and()), contains, order, limit,
 * range, single, maybeSingle, insert, update, upsert (with onConflict),
 * delete, and rpc("deduct_credits").
 *
 * Notes on fidelity:
 * - Timestamps are stored as ISO strings (as supabase-js serialized them),
 *   so ordering/comparison semantics are unchanged.
 * - Rows without an explicit id get a random UUID, as Postgres gen_random_uuid().
 * - inserts default created_at/updated_at to now, like the old timestamptz
 *   DEFAULT now() columns.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function err(code, message) {
  return { code, message, details: null, hint: null };
}

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Supabase `or("a.eq.1,and(b.is.null,c.lt.X)")` → Firestore filter. */
function parseOrFilter(str, foreignTable) {
  // Split on commas that are not inside parentheses.
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of str) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);

  const filters = parts.map((part) => {
    const andMatch = part.match(/^and\((.*)\)$/);
    if (andMatch) {
      const inner = andMatch[1]
        .split(/,(?![^(]*\))/)
        .map((c) => parseCondition(c, foreignTable));
      return inner.length === 1 ? inner[0] : Filter.and(...inner);
    }
    return parseCondition(part, foreignTable);
  });
  return filters.length === 1 ? filters[0] : Filter.or(...filters);
}

function parseCondition(cond, foreignTable) {
  const m = cond.match(/^([a-zA-Z0-9_]+)\.(eq|neq|gt|gte|lt|lte|is|in)\.(.*)$/s);
  if (!m) throw new Error(`[firestore-shim] cannot parse or-condition: ${cond}`);
  const [, field, op, rawValue] = m;
  let value = rawValue;
  if (op === "is") value = rawValue === "null" ? null : rawValue;
  else if (rawValue === "null") value = null;
  else if (rawValue === "true") value = true;
  else if (rawValue === "false") value = false;
  else if (/^-?\d+(\.\d+)?$/.test(rawValue)) value = Number(rawValue);
  return toFilter(field, op, value, foreignTable);
}

function toFilter(field, op, value, foreignTable) {
  const name = foreignTable ? `${foreignTable}.${field}` : field;
  switch (op) {
    case "eq":
    case "is":
      return Filter.where(name, "==", value);
    case "neq":
      return Filter.where(name, "!=", value);
    case "gt":
      return Filter.where(name, ">", value);
    case "gte":
      return Filter.where(name, ">=", value);
    case "lt":
      return Filter.where(name, "<", value);
    case "lte":
      return Filter.where(name, "<=", value);
    case "in":
      return Filter.where(name, "in", Array.isArray(value) ? value : [value]);
    default:
      throw new Error(`[firestore-shim] unsupported operator: ${op}`);
  }
}

/** Parse `a,b` / `*, clips(title)` / `clips(count)` select strings. */
function parseSelect(selectStr) {
  if (!selectStr) return { embeds: [] };
  const embeds = [];
  for (const part of selectStr.split(",").map((s) => s.trim())) {
    const m = part.match(/^([a-zA-Z0-9_]+)\((.*)\)$/);
    if (m && m[2] !== undefined) embeds.push({ relation: m[1], arg: m[2].trim() });
  }
  return { embeds };
}

// relation → how it links back to the parent, derived from the old schema.
const RELATIONS = {
  clips: { childOf: "project_id" },
  jobs: { childOf: "project_id" },
};

class FirestoreQuery {
  constructor(table) {
    this.table = table;
    this.filters = []; // {make: () => Filter | null}
    this.orderSpecs = [];
    this.limitN = null;
    this.rangeFrom = null;
    this.rangeTo = null;
    this.selectStr = "*";
    this.countMode = null; // "exact" | "planned"
    this.head = false;
    this.singleMode = null; // "single" | "maybeSingle"
    this._resolved = false;
    this._result = null;
    this._error = null;
  }

  select(selectStr = "*", opts = {}) {
    if (opts && typeof opts === "object" && opts.count) this.countMode = opts.count;
    this.head = Boolean(opts?.head);
    this.selectStr = selectStr;
    return this;
  }

  _addFilter(field, op, value) {
    this.filters.push({ make: () => toFilter(field, op, value) });
    return this;
  }

  eq(f, v) { return this._addFilter(f, "eq", v); }
  neq(f, v) { return this._addFilter(f, "neq", v); }
  gt(f, v) { return this._addFilter(f, "gt", v); }
  gte(f, v) { return this._addFilter(f, "gte", v); }
  lt(f, v) { return this._addFilter(f, "lt", v); }
  lte(f, v) { return this._addFilter(f, "lte", v); }
  in(f, v) { return this._addFilter(f, "in", v); }
  is(f, v) { return this._addFilter(f, "eq", v); }

  contains(f, v) {
    this.filters.push({ make: () => Filter.where(f, "array-contains", v) });
    return this;
  }

  // `.not("field", "is", null)` → "IS NOT NULL"; negate the operator.
  not(field, op, value) {
    const NEG = { is: "!=", eq: "!=", neq: "==", gt: "<=", gte: "<", lt: ">=", lte: ">" };
    const neg = NEG[op];
    if (!neg) throw new Error(`[firestore-shim] unsupported not(${op})`);
    this.filters.push({ make: () => Filter.where(field, neg, value) });
    return this;
  }

  or(expr) {
    const table = this._orTable ?? null;
    this.filters.push({ make: () => parseOrFilter(expr, null), tableHint: table });
    return this;
  }

  match(obj) {
    for (const [k, v] of Object.entries(obj)) this.eq(k, v);
    return this;
  }

  order(field, opts = {}) {
    this.orderSpecs.push({ field, ascending: opts.ascending !== false });
    return this;
  }

  limit(n) {
    this.limitN = n;
    return this;
  }

  range(from, to) {
    this.rangeFrom = from;
    this.rangeTo = to;
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

  then(onFulfilled, onRejected) {
    return this._run().then(onFulfilled, onRejected);
  }

  /** Update rows matching the current filters. */
  update(patch) {
    this._mutation = { type: "update", patch };
    return this;
  }

  upsert(payload, opts = {}) {
    this._mutation = { type: "upsert", payload, onConflict: opts.onConflict };
    return this;
  }

  /** Insert; supports the .select().single() chain some routes use. */
  insert(payload) {
    this._mutation = { type: "insert", payload };
    return this;
  }

  delete() {
    this._mutation = { type: "delete" };
    return this;
  }

  async _buildConstraints(foreignTable = null) {
    const list = [];
    for (const f of this.filters) {
      const flt = f.make();
      if (flt) list.push(flt);
    }
    // Firestore has no offset; emulate range() client-side when used.
    if (this.limitN != null || this.rangeFrom != null) {
      // fetch enough docs to emulate offset client-side
    }
    return list;
  }

  async _queryRows(foreignTable = null, maxFetch = 2000) {
    let q = db().collection(foreignTable ?? this.table);
    const constraints = await this._buildConstraints(foreignTable);
    if (constraints.length === 1) q = q.where(constraints[0]);
    else if (constraints.length > 1) q = q.where(Filter.and(...constraints));

    for (const o of this.orderSpecs) q = q.orderBy(o.field, o.ascending ? "asc" : "desc");

    const upper =
      this.rangeTo != null ? this.rangeTo + 1 : this.limitN ?? maxFetch;
    q = q.limit(upper);

    const snap = await q.get();
    let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (this.rangeFrom != null) rows = rows.slice(this.rangeFrom);
    return rows;
  }

  async _countRows(foreignTable = null) {
    let q = db().collection(foreignTable ?? this.table);
    const constraints = await this._buildConstraints(foreignTable);
    if (constraints.length === 1) q = q.where(constraints[0]);
    else if (constraints.length > 1) q = q.where(Filter.and(...constraints));
    const snap = await q.count().get();
    return snap.data().count;
  }

  async _applyEmbeds(rows) {
    const { embeds } = parseSelect(this.selectStr);
    for (const { relation, arg } of embeds) {
      const rel = RELATIONS[relation];
      const fk = `${relation.replace(/s$/, "")}_id`;
      const isFkEmbed = rows.some((r) => r[fk] != null);
      if (rel?.childOf && !isFkEmbed) {
        // children via <relation>.<childOf> == parent id (or a count embed)
        const parentIds = [...new Set(rows.map((r) => r.id))].filter(Boolean);
        const chunks = [];
        for (let i = 0; i < parentIds.length; i += 30) {
          chunks.push(parentIds.slice(i, i + 30));
        }
        const counts = new Map();
        for (const chunk of chunks) {
          const q = db().collection(relation).where(rel.childOf, "in", chunk);
          const snap = await q.get();
          for (const d of snap.docs) {
            const pid = d.data()[rel.childOf];
            counts.set(pid, (counts.get(pid) ?? 0) + 1);
          }
        }
        for (const row of rows) {
          if (arg === "count") {
            row[relation] = [{ count: counts.get(row.id) ?? 0 }];
          } else {
            row[relation] = []; // child embeds of this shape aren't used in-app
          }
        }
      } else {
        // foreign-key embed: <singular relation>_id column on the parent
        const fkIds = [...new Set(rows.map((r) => r[fk]).filter(Boolean))];
        const byId = new Map();
        for (let i = 0; i < fkIds.length; i += 30) {
          const snap = await db()
            .collection(relation)
            .where("__name__", "in", fkIds.slice(i, i + 30))
            .get();
          for (const d of snap.docs) byId.set(d.id, { id: d.id, ...d.data() });
        }
        for (const row of rows) {
          const target = byId.get(row[fk]);
          if (arg === "count") {
            row[relation] = [{ count: target ? 1 : 0 }];
          } else {
            row[relation] = target
              ? arg && arg !== "*"
                ? [Object.fromEntries(arg.split(",").map((c) => [c.trim(), target[c.trim()]]))]
                : [target]
              : [];
          }
        }
      }
    }
    return rows;
  }

  async _run() {
    // Mutations short-circuit the read path.
    if (this._mutation) {
      const result = await this._runMutation();
      // Support the `.insert(...).select("id").single()` chain some routes
      // use: treat post-mutation selects as no-ops on the returned row(s).
      const chainable = {
        select() { return chainable; },
        single() { return chainable; },
        maybeSingle() { return chainable; },
        then(onFulfilled, onRejected) {
          return Promise.resolve(result).then(onFulfilled, onRejected);
        },
      };
      return chainable;
    }

    if (this.countMode && this.head) {
      const count = await this._countRows();
      return { data: null, error: null, count, status: 200, statusText: "OK" };
    }

    let rows;
    if (this.countMode) {
      const count = await this._countRows();
      rows = await this._queryRows();
      return {
        data: rows,
        error: null,
        count,
        status: 200,
        statusText: "OK",
      };
    }

    rows = await this._queryRows();

    if (this.singleMode) {
      if (rows.length === 0) {
        return {
          data: null,
          error: err("PGRST116", "The result contains 0 rows"),
          status: 406,
          statusText: "Not Acceptable",
        };
      }
      rows = rows.slice(0, 1);
    }

    rows = await this._applyEmbeds(rows);
    const data = this.singleMode ? rows[0] ?? null : rows;
    return { data, error: null, status: 200, statusText: "OK" };
  }

  async _runMutation() {
    const { type, patch, payload, onConflict } = this._mutation;
    try {
      if (type === "insert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        const out = [];
        for (const row of rows) {
          const doc = { created_at: nowIso(), updated_at: nowIso(), ...row };
          const id = doc.id && UUID_RE.test(String(doc.id)) ? String(doc.id) : undefined;
          const ref = id
            ? db().collection(this.table).doc(id)
            : db().collection(this.table).doc(randomUUID());
          await ref.set(doc, { merge: false });
          out.push({ id: ref.id, ...doc });
        }
        const data = Array.isArray(payload) ? out : out[0];
        return { data, error: null, status: 201, statusText: "Created" };
      }

      if (type === "upsert") {
        const rows = Array.isArray(payload) ? payload : [payload];
        const conflictCols = onConflict
          ? onConflict.split(",").map((c) => c.trim())
          : ["id"];
        const out = [];
        for (const row of rows) {
          const doc = { created_at: nowIso(), updated_at: nowIso(), ...row };
          const conflict = Object.fromEntries(
            conflictCols.map((c) => [c, doc[c]])
          );
          const id = conflictCols.every((c) => doc[c] != null)
            ? conflictCols.map((c) => String(doc[c])).join("|")
            : randomUUID();
          await db().collection(this.table).doc(id).set(doc, { merge: true });
          out.push({ id, ...doc });
        }
        const data = Array.isArray(payload) ? out : out[0];
        return { data, error: null, status: 201, statusText: "Created" };
      }

      if (type === "update") {
        const rows = await this._queryRows();
        const batch = db().batch();
        for (const row of rows) {
          batch.set(
            db().collection(this.table).doc(row.id),
            { ...patch, updated_at: nowIso() },
            { merge: true }
          );
        }
        await batch.commit();
        const data = rows.map((r) => ({ ...r, ...patch }));
        return { data, error: null, status: 200, statusText: "OK" };
      }

      if (type === "delete") {
        const rows = await this._queryRows();
        const batch = db().batch();
        for (const row of rows) batch.delete(db().collection(this.table).doc(row.id));
        await batch.commit();
        return { data: rows, error: null, status: 200, statusText: "OK" };
      }
    } catch (e) {
      return { data: null, error: err("23505", e.message), status: 400, statusText: "Bad Request" };
    }
  }
}

/** Stand-in for the old Postgres `deduct_credits(p_user_id, p_amount)` fn. */
async function deductCredits(userId, amount) {
  const ref = db().collection("profiles").doc(userId);
  let result = null;
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = Number(snap.data()?.credits_remaining ?? 0);
    if (!snap.exists || current < amount) return;
    const remaining = current - amount;
    tx.update(ref, { credits_remaining: remaining, updated_at: nowIso() });
    result = remaining;
  });
  return result;
}

export function createClient() {
  return {
    from(table) {
      return new FirestoreQuery(table);
    },
    async rpc(fn, args = {}) {
      if (fn === "deduct_credits") {
        const data = await deductCredits(args.p_user_id, args.p_amount);
        return { data, error: data === null ? err("P0002", "insufficient credits") : null };
      }
      throw new Error(`[firestore-shim] unknown rpc: ${fn}`);
    },
    // Not used by the backend, but kept so accidental references fail loudly
    // instead of mysteriously.
    channel() {
      throw new Error("[firestore-shim] realtime channels are not supported server-side");
    },
  };
}
