-- Every guided replay a person finishes or abandons; the library shows usage from this.
create table public.guided_runs (
  id bigint generated always as identity primary key,
  workflow_id text not null references public.workflows (id) on delete cascade,
  person text,
  outcome text not null,
  assists int not null default 0,
  seconds int,
  at timestamptz not null default now()
);
create index guided_runs_workflow_idx on public.guided_runs (workflow_id);
alter table public.guided_runs enable row level security;
create policy "read guided runs" on public.guided_runs for select to anon, authenticated using (true);
