// Text embeddings from the gte-small model (384 dimensions), served by the
// `embed` Edge Function. Returns null when the function is not deployed yet, so search falls
// back to full text.
import { config } from "./config.js";

let disabled = false;

export async function embed(text) {
  if (disabled || !text) return null;
  const res = await fetch(`${config.supabaseUrl}/functions/v1/embed`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.supabaseAnonKey}`, apikey: config.supabaseAnonKey },
    body: JSON.stringify({ input: String(text).slice(0, 2000) }),
  });
  if (res.status === 404) { disabled = true; return null; }
  if (!res.ok) throw new Error(`embed ${res.status}`);
  const { embedding } = await res.json();
  return Array.isArray(embedding) ? embedding : null;
}

export const workflowText = (wf) => `${wf.task}. ${wf.synonyms || ""}. On ${wf.site}. ${(wf.trail || []).map((s) => s.instruction).join(" ")}`;
