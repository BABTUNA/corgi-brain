// The master copy of every workflow and exploration, in Postgres. Each row keeps the
// JSON document the pages and the extension use; the columns beside it are for search and
// realtime. Screenshots go to the public `frames` Storage bucket.
import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";

export const db = createClient(config.supabaseUrl, config.supabaseServiceKey, { auth: { persistSession: false } });

const must = ({ data, error }) => { if (error) throw new Error(`supabase: ${error.message}`); return data; };

export function slugify(s) {
  return String(s || "workflow").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "workflow";
}

export async function uniqueId(base) {
  const root = slugify(base);
  const taken = new Set(must(await db.from("workflows").select("id").like("id", `${root}%`)).map((r) => r.id));
  let id = root, n = 2;
  while (taken.has(id)) id = `${root}-${n++}`;
  return id;
}

export async function saveWorkflow(wf, embedding) {
  const row = { id: wf.id, doc: wf, task: wf.task, site: wf.site, taught_by: wf.taughtBy || "human", recorded_at: wf.recordedAt };
  if (embedding) row.embedding = embedding;
  must(await db.from("workflows").upsert(row));
  return wf;
}

export async function getWorkflow(id) {
  // Look up the exact id: ids made by uniqueId can be longer than slugify's 60-character cap.
  const rows = must(await db.from("workflows").select("doc").eq("id", String(id).slice(0, 200)).limit(1));
  return rows[0]?.doc || null;
}

export async function listWorkflows() {
  return must(await db.from("workflows").select("doc").order("recorded_at", { ascending: false })).map((r) => r.doc);
}

export async function searchWorkflows(q, embedding, count = 5) {
  return must(await db.rpc("hybrid_search", { query_text: q, query_embedding: embedding || null, match_count: count }));
}

// Explorations are saved many times a second while agents race; coalesce writes per id so the
// newest state always lands last and Postgres sees at most one write in flight per exploration.
const pending = new Map();
export function saveExploration(ex) {
  let slot = pending.get(ex.id);
  if (!slot) pending.set(ex.id, (slot = { dirty: false, running: null }));
  slot.dirty = true;
  if (!slot.running) {
    slot.running = (async () => {
      while (slot.dirty) {
        slot.dirty = false;
        ex.updatedAt = new Date().toISOString();
        const { error } = await db.from("explorations").upsert({ id: ex.id, doc: ex, goal: ex.goal, status: ex.status, started_at: ex.startedAt, updated_at: ex.updatedAt });
        if (error) console.warn("[store] exploration save:", error.message);
      }
      slot.running = null;
    })();
  }
  return ex;
}

/** Resolves once every queued exploration write has landed. */
export async function flushExploration(id) {
  await pending.get(id)?.running;
}

const STALE_MS = 15 * 60_000;
/** An exploration still "running" long after it started belongs to a bridge that died mid-run. */
export function withStaleness(ex) {
  if (ex.status === "running" && Date.now() - new Date(ex.startedAt).getTime() > STALE_MS) return { ...ex, status: "stale" };
  return ex;
}

export async function getExploration(id) {
  const rows = must(await db.from("explorations").select("doc").eq("id", String(id)).limit(1));
  return rows[0] ? withStaleness(rows[0].doc) : null;
}

export async function listExplorations() {
  return must(await db.from("explorations").select("doc").order("started_at", { ascending: false }).limit(200)).map((r) => withStaleness(r.doc));
}

export async function uploadFrame(path, bytes) {
  must(await db.storage.from("frames").upload(path, bytes, { contentType: "image/jpeg", upsert: true }));
  return db.storage.from("frames").getPublicUrl(path).data.publicUrl;
}

export async function logGuidedRun({ id, user, outcome, assists = 0, seconds }) {
  must(await db.from("guided_runs").insert({ workflow_id: id, person: user || null, outcome: String(outcome || "unknown"), assists: Number(assists) || 0, seconds: Number.isFinite(Number(seconds)) ? Math.round(seconds) : null }));
}

export async function guidedRunStats() {
  const rows = must(await db.from("guided_runs").select("workflow_id, person, outcome, at"));
  const stats = {};
  for (const r of rows) {
    const s = (stats[r.workflow_id] ||= { completed: 0, people: new Set(), last: null });
    if (r.outcome === "completed") { s.completed++; if (r.person) s.people.add(r.person); }
    if (!s.last || r.at > s.last) s.last = r.at;
  }
  return stats;
}
