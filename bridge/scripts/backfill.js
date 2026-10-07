// Embeds every workflow that has no vector yet (e.g. saved before the embed function existed).
import { db } from "../lib/store.js";
import { embed, workflowText } from "../lib/embed.js";

const { data, error } = await db.from("workflows").select("id, doc").is("embedding", null);
if (error) throw error;
for (const r of data) await db.from("workflows").update({ embedding: await embed(workflowText(r.doc)) }).eq("id", r.id);
console.log(`embedded ${data.length} workflows`);
