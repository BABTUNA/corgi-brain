// "Add to Claude as a Skill": packages a workflow as a Claude Agent Skill (a folder with SKILL.md)
// in a .zip that Claude.ai or Claude Code can load. The skill carries the team's verified steps,
// and tells Claude to run them through Corgi Brain's run_workflow when the connector is available.
import { deflateRawSync } from "node:zlib";
import { slugify } from "./store.js";

// Skill names: lowercase letters, digits and hyphens, at most 64 characters, and they may not
// contain the reserved words "claude" or "anthropic".
export const skillName = (wf) => slugify(wf.task).replace(/claude|anthropic/g, "ai").slice(0, 64).replace(/-+$/, "") || "team-workflow";

const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();

export function skillMarkdown(wf, { guideUrl }) {
  const taught = wf.taughtBy === "agent"
    ? `discovered by ${wf.agentCount === 1 ? "a Claude agent" : `${wf.agentCount || "several"} Claude agents`} and checked by Claude Opus from screenshots`
    : `recorded by ${wf.recordedBy || "a teammate"} and cleaned up by Claude`;
  const asks = oneLine(wf.synonyms).replace(/[,.]\s*$/, "");
  const description = oneLine(`How our team does "${wf.task}" on ${wf.site}. Use when the user wants to ${wf.task.replace(/^./, (c) => c.toLowerCase())}${asks ? ` or asks things like: ${asks}` : ""}. Gives the team's verified steps and how to run them with Corgi Brain.`).slice(0, 1000);
  const steps = (wf.trail || []).map((s, i) => {
    const hint = s.kind === "verify" ? "" : [s.target?.text && `element text "${s.target.text}"`, s.field && `field "${s.field}"`, s.href && `link ${s.href}`].filter(Boolean).join(", ");
    return `${i + 1}. ${s.instruction}${hint ? `  \n   _(${hint})_` : ""}`;
  }).join("\n");
  const needsLogin = (wf.trail || []).some((s) => s.secret) || wf.taughtBy !== "agent";
  return `---
name: ${skillName(wf)}
description: ${JSON.stringify(description)}
---

# ${wf.task}

The team's verified path on **${wf.site}**, ${taught}. From Corgi Brain, the team's shared know-how for its web apps.

Start at: ${wf.startUrl || `https://${wf.site}`}

## Steps

${steps}

## How to help the user

- **Corgi Brain connector available?** Call \`run_workflow\` with id \`${wf.id}\` to replay this path in a headless browser and get the page it ends on.${needsLogin ? " This path was recorded in a teammate's logged-in session, so if it needs the user's own account, guide them instead." : ""}
- **Guiding a person:** give them the steps above, or send them to ${guideUrl}. The Corgi Brain browser extension highlights each step on the real page.
- **The site changed and a step no longer matches?** Say so, and suggest re-running it through Corgi Brain, which repairs the path, or asking a teammate to record it again.
- Do not invent steps, menus or URLs that are not listed here.

<!-- corgi-brain workflow ${wf.id}, exported ${new Date().toISOString().slice(0, 10)} -->
`;
}

// Minimal ZIP writer (deflate), enough for a one-folder skill.
const CRC_TABLE = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const { name, content } of files) {
    const data = Buffer.from(content, "utf8"), packed = deflateRawSync(data), nameBuf = Buffer.from(name, "utf8"), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export function skillZip(wf, opts) {
  const name = skillName(wf);
  return { filename: `${name}.zip`, buffer: zip([{ name: `${name}/SKILL.md`, content: skillMarkdown(wf, opts) }]) };
}
