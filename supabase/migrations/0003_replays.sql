-- Every time an agent (or the API) replays a saved workflow instead of exploring from scratch.
create table public.replays (
  id bigint generated always as identity primary key,
  workflow_id text not null references public.workflows (id) on delete cascade,
  caller text not null default 'api',
  ok boolean not null,
  seconds numeric(8, 2) not null,
  failed_at int,
  reason text,
  healed boolean not null default false,
  heal_cost_usd numeric(10, 4) not null default 0,
  saved_seconds numeric(8, 2) not null default 0,
  saved_usd numeric(10, 4) not null default 0,
  steps jsonb not null default '[]',
  at timestamptz not null default now()
);
create index replays_at_idx on public.replays (at desc);
create index replays_workflow_idx on public.replays (workflow_id);
alter table public.replays enable row level security;
create policy "read replays" on public.replays for select to anon, authenticated using (true);
alter publication supabase_realtime add table public.replays;
