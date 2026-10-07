// Trail helpers shared by Record and Explore: parse an agent's JSON reply into
// Corgi Brain's trail format, and rank competing trails.

export function parseTrail(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { outcome: "gave_up", trail: null, deadEnds: null };
  try {
    const p = JSON.parse(m[0]);
    const trail = Array.isArray(p.trail) ? p.trail.filter((s) => s && s.instruction).map((s) => ({
      kind: ["click", "fill", "select", "nav", "verify"].includes(s.kind) ? s.kind : "click",
      instruction: String(s.instruction).trim(),
      target: s.target && typeof s.target === "object" ? { tag: String(s.target.tag || "").toLowerCase(), text: String(s.target.text || "").toLowerCase() } : undefined,
      fid: typeof s.fid === "string" && s.fid ? s.fid : undefined,
      url: typeof s.url === "string" ? s.url : undefined,
      href: typeof s.href === "string" && /^https?:\/\//.test(s.href) ? s.href : undefined,
    })) : null;
    const outcome = ["reached", "gave_up", "login_required", "blocked"].includes(p.outcome) ? p.outcome : (trail?.length ? "reached" : "gave_up");
    return { outcome, trail, deadEnds: Number(p.deadEnds) || 0 };
  } catch {
    return { outcome: "gave_up", trail: null, deadEnds: null };
  }
}

/** Fewest steps wins; dead ends break ties; fingerprints are a bonus (they replay without vision). */
export function rankTrails(agents) {
  const score = (a) => (a.trail?.length ?? 99) * 10 + (a.deadEnds ?? 0) * 3 - (a.trail?.filter((s) => s.fid).length ?? 0);
  return [...agents].filter((a) => a.trail?.length).sort((x, y) => score(x) - score(y));
}
