// Finds the workflow that best answers a question: Postgres hybrid search (full text plus
// vector similarity, fused in SQL), then token overlap over the library as a last resort.
import { listWorkflows, searchWorkflows } from "./store.js";
import { embed } from "./embed.js";

const STOP = new Set("how do i a an the to my on in of for and can you what is with".split(" "));
const tokens = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t));

export async function searchLibrary(q, count = 5) {
  const vector = await embed(q).catch(() => null);
  return (await searchWorkflows(q, vector, count)).map((r) => ({ wf: r.doc, score: r.score }));
}

export async function findWorkflow(q) {
  try {
    const [top] = await searchLibrary(q, 1);
    if (top) return { wf: top.wf, source: "hybrid" };
  } catch (err) { console.warn("[search]", err.message); }
  const qt = tokens(q);
  let best = null;
  for (const wf of await listWorkflows()) {
    const hay = new Set(tokens(`${wf.task} ${wf.synonyms} ${wf.site}`));
    const score = qt.filter((t) => hay.has(t)).length / Math.max(qt.length, 1);
    if (score > 0 && (!best || score > best.score)) best = { wf, score };
  }
  return best && best.score >= 0.34 ? { wf: best.wf, source: "keyword" } : null;
}
