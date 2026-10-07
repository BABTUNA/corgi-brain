// Loads the sample workflows in data/workflows/*.json into the database (upsert by id).
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { saveWorkflow } from "../lib/store.js";
import { embed, workflowText } from "../lib/embed.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "workflows");
let n = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  const wf = JSON.parse(readFileSync(join(dir, f), "utf8"));
  wf.recordedAt ||= new Date().toISOString();
  await saveWorkflow(wf, await embed(workflowText(wf)).catch(() => null));
  n++;
}
console.log(`seeded ${n} workflows`);
