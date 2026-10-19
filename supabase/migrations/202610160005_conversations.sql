-- Ejecutar una sola vez, después de 001–004. No hace llamadas de IA.
begin;
create table public.notebook_turns (
  id uuid primary key default gen_random_uuid(),
  notebook_id uuid not null references public.notebooks(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  question text not null check (char_length(btrim(question)) between 1 and 1000),
  answer jsonb not null check (jsonb_typeof(answer) = 'object' and octet_length(answer::text) <= 65536),
  created_at timestamptz not null default now()
);
create index notebook_turns_owner_book_created_idx on public.notebook_turns(owner_id,notebook_id,created_at desc,id desc);
alter table public.notebook_turns enable row level security;
alter table public.notebook_turns force row level security;
create policy notebook_turns_select_own on public.notebook_turns for select to authenticated
  using (owner_id = (select auth.uid()) and exists(select 1 from public.notebooks n where n.id = notebook_id and n.owner_id = (select auth.uid())));
create policy notebook_turns_insert_own on public.notebook_turns for insert to authenticated
  with check (owner_id = (select auth.uid()) and exists(select 1 from public.notebooks n where n.id = notebook_id and n.owner_id = (select auth.uid())));
create policy notebook_turns_delete_own on public.notebook_turns for delete to authenticated
  using (owner_id = (select auth.uid()) and exists(select 1 from public.notebooks n where n.id = notebook_id and n.owner_id = (select auth.uid())));
revoke all on public.notebook_turns from public,anon,authenticated;
grant select,delete on public.notebook_turns to authenticated;
grant insert(notebook_id,owner_id,question,answer) on public.notebook_turns to authenticated;
commit;
