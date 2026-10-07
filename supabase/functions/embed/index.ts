// Embeds text with Supabase's built-in gte-small model (384 dimensions, runs inside the Edge
// Runtime, no third-party key). The bridge calls this when saving and searching workflows.
const session = new Supabase.ai.Session("gte-small");

Deno.serve(async (req) => {
  const { input } = await req.json().catch(() => ({}));
  if (typeof input !== "string" || !input.trim()) {
    return Response.json({ error: "input must be a non-empty string" }, { status: 400 });
  }
  const embedding = await session.run(input.slice(0, 2000), { mean_pool: true, normalize: true });
  return Response.json({ embedding });
});
