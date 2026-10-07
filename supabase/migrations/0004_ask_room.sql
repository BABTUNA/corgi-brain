-- The Ask room: a shared team chat where people and agents ask how to do things in the org's web
-- apps, Corgi Brain answers from the workflow library, and new or healed workflows are announced.
create table public.messages (
  id bigint generated always as identity primary key,
  room text not null default 'team',
  kind text not null check (kind in ('question', 'answer', 'announcement', 'request')),
  author text not null,
  author_kind text not null default 'person' check (author_kind in ('person', 'agent', 'brain')),
  body text not null,
  cards jsonb not null default '[]',
  meta jsonb not null default '{}',
  reply_to bigint references public.messages (id) on delete set null,
  at timestamptz not null default now()
);
create index messages_room_at_idx on public.messages (room, at desc);
alter table public.messages enable row level security;
create policy "read messages" on public.messages for select to anon, authenticated using (true);
alter publication supabase_realtime add table public.messages;
