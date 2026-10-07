import type { McpServer } from 'npm:@modelcontextprotocol/server@2.0.0'
import { z } from 'npm:zod@4.6.2'

import { errorResult, jsonResult, runtimeErrorResult } from './result.ts'
import type { ToolContext } from './types.ts'

// Corgi Brain's tools: the team's know-how for its web apps. Reads (search, workflows, explorations,
// sites) go through the signed-in user's RLS-scoped client. Anything that needs a browser or Claude
// (ask, run, explore) goes to the Corgi Brain bridge on Supabase Compute, labelled with who asked.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const BRIDGE = (Deno.env.get('CORGI_BRAIN_BRIDGE') ?? `${SUPABASE_URL}/compute/v1/bridge`).replace(/\/+$/, '')

type Trail = { n?: number; kind: string; instruction: string; target?: unknown; fid?: string; field?: string; href?: string; url?: string }
type Workflow = { id: string; task: string; site: string; startUrl?: string; taughtBy?: string; agentCount?: number; recordedBy?: string; trail?: Trail[] }

const taught = (wf: Workflow) =>
  wf.taughtBy === 'agent'
    ? `discovered by ${wf.agentCount === 1 ? 'a Claude agent' : `${wf.agentCount ?? 'several'} Claude agents`}`
    : `recorded by ${wf.recordedBy ?? 'a teammate'}`

const card = (wf: Workflow) => ({
  id: wf.id, task: wf.task, site: wf.site, startUrl: wf.startUrl ?? null, taught: taught(wf),
  steps: (wf.trail ?? []).map((s) => s.instruction),
  guideUrl: `${BRIDGE}/guide/${wf.id}`,
})

async function embed(text: string): Promise<number[] | null> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ANON_KEY}`, apikey: ANON_KEY },
    body: JSON.stringify({ input: text }),
  }).catch(() => null)
  return res?.ok ? (await res.json()).embedding ?? null : null
}

async function bridge(path: string, body: unknown) {
  const res = await fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error ?? `Corgi Brain answered ${res.status}`)
  return data
}

export function registerBrainTools(server: McpServer, { supabase, userClaims }: ToolContext): void {
  const who = userClaims.email ?? userClaims.id

  server.registerTool(
    'ask',
    {
      description: "Ask how this team does something in its web apps, e.g. 'how do I add a Codespaces secret?'. Corgi Brain answers in the team's Ask room from workflows teammates recorded and agents discovered, and returns the matching workflows with their steps. The team sees the question. Use run_workflow with a returned id to do it.",
      inputSchema: z.object({ question: z.string().min(3).max(500), agentName: z.string().max(30).optional().describe("How to label you in the room, e.g. 'Claude Code'") }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ question, agentName }) => {
      try {
        const { answer } = await bridge('/ask', { question, author: `${agentName ?? 'Agent'} for ${who}`.slice(0, 40), authorKind: 'agent' })
        return jsonResult({
          answer: answer.body,
          workflows: (answer.cards ?? []).map((c: { id: string; task: string; site: string; who: string; steps: string[] }) => ({ id: c.id, task: c.task, site: c.site, taught: c.who, steps: c.steps, guideUrl: `${BRIDGE}/guide/${c.id}` })),
          ...(answer.meta?.gap ? { gap: 'Nobody on the team has taught this yet.', ...(answer.meta.explore ? { canExplore: answer.meta.explore } : {}) } : {}),
        })
      } catch (error) { return runtimeErrorResult(error) }
    }
  )

  server.registerTool(
    'search_workflows',
    {
      description: "Find the team's verified step-by-step workflows for doing something on a website, by meaning (plain-language questions work). Returns ids for get_workflow and run_workflow.",
      inputSchema: z.object({ query: z.string().min(2), site: z.string().optional().describe('Restrict to a hostname, e.g. github.com'), limit: z.number().int().min(1).max(10).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, site, limit }) => {
      try {
        const n = limit ?? 5
        const { data, error } = await supabase.rpc('hybrid_search', { query_text: query, query_embedding: await embed(query), match_count: site ? n * 3 : n })
        if (error) throw error
        const hits = (data as { doc: Workflow; score: number }[]).filter((r) => !site || r.doc.site === site.replace(/^www\./, '')).slice(0, n)
        if (!hits.length) return jsonResult({ results: [], note: `Nothing in the team's brain matches "${query}". Ask a teammate to record it, or use explore_site for a public site.` })
        return jsonResult({ results: hits.map((r) => ({ ...card(r.doc), score: Math.round(r.score * 10000) / 10000 })) })
      } catch (error) { return runtimeErrorResult(error) }
    }
  )

  server.registerTool(
    'get_workflow',
    {
      description: "Full steps of one workflow: each step's instruction, the element to click or field to fill, and a fingerprint for finding it again.",
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        const { data, error } = await supabase.from('workflows').select('doc').eq('id', id).maybeSingle()
        if (error) throw error
        if (!data) return errorResult(`No workflow with id "${id}".`)
        const wf = data.doc as Workflow
        return jsonResult({ ...card(wf), steps: (wf.trail ?? []).map((s) => ({ n: s.n, kind: s.kind, instruction: s.instruction, element: s.target, fingerprint: s.fid, field: s.field, href: s.href, urlAfter: s.url })) })
      } catch (error) { return runtimeErrorResult(error) }
    }
  )

  server.registerTool(
    'run_workflow',
    {
      description: "Replay a saved workflow in a headless browser and get the page it ends on (URL, title, text). No model calls: seconds and $0 instead of exploring. If the site changed, the path heals itself. Fill steps recorded by people need inputs keyed by step number.",
      inputSchema: z.object({ id: z.string(), inputs: z.record(z.string(), z.string()).optional(), heal: z.boolean().optional() }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ id, inputs, heal }) => {
      try {
        const r = await bridge(`/workflows/${encodeURIComponent(id)}/run`, { inputs: inputs ?? {}, heal: heal !== false, caller: `mcp:${who}`.slice(0, 40) })
        return jsonResult({
          ok: r.ok, seconds: r.seconds, costUsd: r.costUsd,
          saved: r.ok ? `${r.saved.seconds}s and $${r.saved.usd} compared with exploring from scratch` : null,
          healed: r.healed, failedAt: r.failedAt ?? null, reason: r.reason ?? null,
          finalUrl: r.finalUrl, title: r.title, pageText: r.pageText,
        })
      } catch (error) { return runtimeErrorResult(error) }
    }
  )

  server.registerTool(
    'explore_site',
    {
      description: 'When nobody has taught it and it is on a public website, race several Claude agents (each in its own browser) toward the goal. Takes a minute or two; poll get_exploration. Agents never log in.',
      inputSchema: z.object({ goal: z.string().min(4).max(300), url: z.string().url(), agents: z.number().int().min(1).max(6).optional() }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ goal, url, agents }) => {
      try {
        const ex = await bridge('/explore', { goal, url, agents: agents ?? 3 })
        return jsonResult({ explorationId: ex.id, watchLive: `${BRIDGE}/explore/${ex.id}`, next: 'Call get_exploration with this id in about a minute.' })
      } catch (error) { return runtimeErrorResult(error) }
    }
  )

  server.registerTool(
    'get_exploration',
    {
      description: "Status of an exploration: each agent's outcome, the judge's verdicts, and the saved workflow id once one wins.",
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        const { data, error } = await supabase.from('explorations').select('doc').eq('id', id).maybeSingle()
        if (error) throw error
        if (!data) return errorResult(`No exploration with id "${id}".`)
        const ex = data.doc as { status: string; goal: string; cost?: number; winner?: { workflowId: string; agent: number }; agents: { i: number; strategy: string; status: string; outcome?: string; steps?: number; evals?: { slug: string; rating?: number; passed?: boolean }[] }[] }
        return jsonResult({
          status: ex.status, goal: ex.goal, costUsd: ex.cost ?? 0,
          winner: ex.winner ? { workflowId: ex.winner.workflowId, agent: ex.winner.agent + 1 } : null,
          agents: ex.agents.map((a) => ({ agent: a.i + 1, strategy: a.strategy, status: a.status, outcome: a.outcome, steps: a.steps, judge: (a.evals ?? []).map((e) => `${e.slug}: ${e.rating ?? (e.passed ? 'pass' : 'fail')}`) })),
        })
      } catch (error) { return runtimeErrorResult(error) }
    }
  )

  server.registerTool(
    'list_sites',
    {
      description: "Every web app and site the team's brain knows, with how many workflows each has.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const { data, error } = await supabase.from('workflows').select('site')
        if (error) throw error
        const counts: Record<string, number> = {}
        for (const r of data as { site: string }[]) counts[r.site] = (counts[r.site] ?? 0) + 1
        return jsonResult({ sites: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([site, workflows]) => ({ site, workflows })) })
      } catch (error) { return runtimeErrorResult(error) }
    }
  )
}
