-- Corgi Brain schema. Workflows and explorations keep the JSON shape the bridge pages and the
-- extension already use (in `doc`); the columns beside it are for filtering, search and realtime.

create extension if not exists vector with schema extensions;

create table public.workflows (
  id text primary key,
  doc jsonb not null,
  task text not null,
  site text not null,
  taught_by text not null default 'human' check (taught_by in ('human', 'agent')),
  recorded_at timestamptz not null default now(),
  embedding extensions.vector(384),
  fts tsvector generated always as (
    to_tsvector('english', task || ' ' || site || ' ' || coalesce(doc ->> 'synonyms', ''))
  ) stored
);

create table public.explorations (
  id text primary key,
  doc jsonb not null,
  goal text not null,
  status text not null,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index workflows_recorded_idx on public.workflows (recorded_at desc);
create index workflows_fts_idx on public.workflows using gin (fts);
create index workflows_embedding_idx on public.workflows using hnsw (embedding extensions.vector_cosine_ops);
create index explorations_started_idx on public.explorations (started_at desc);

-- The bridge writes with the service role (bypasses RLS). Browsers only read.
alter table public.workflows enable row level security;
alter table public.explorations enable row level security;
create policy "read workflows" on public.workflows for select to anon, authenticated using (true);
create policy "read explorations" on public.explorations for select to anon, authenticated using (true);

-- Live race: every save of an exploration streams to the page watching it.
alter publication supabase_realtime add table public.explorations;
alter table public.explorations replica identity full;

-- Screenshots each explorer agent saw, one per action.
insert into storage.buckets (id, name, public) values ('frames', 'frames', true)
on conflict (id) do nothing;

-- Hybrid search: full text and vector similarity fused with reciprocal rank fusion.
create or replace function public.hybrid_search(
  query_text text,
  query_embedding extensions.vector(384) default null,
  match_count int default 5,
  rrf_k int default 50
)
returns table (id text, doc jsonb, score double precision)
language sql
stable
set search_path = public, extensions
as $$
  with full_text as (
    select w.id, row_number() over (order by ts_rank_cd(w.fts, websearch_to_tsquery('english', query_text)) desc) as rank_ix
    from public.workflows w
    where w.fts @@ websearch_to_tsquery('english', query_text)
    limit match_count * 2
  ),
  semantic as (
    select w.id, row_number() over (order by w.embedding <=> query_embedding) as rank_ix
    from public.workflows w
    where query_embedding is not null and w.embedding is not null
    order by w.embedding <=> query_embedding
    limit match_count * 2
  )
  select w.id, w.doc,
    coalesce(1.0 / (rrf_k + f.rank_ix), 0.0) + coalesce(1.0 / (rrf_k + s.rank_ix), 0.0) as score
  from full_text f
  full outer join semantic s on f.id = s.id
  join public.workflows w on w.id = coalesce(f.id, s.id)
  order by score desc
  limit match_count;
$$;
