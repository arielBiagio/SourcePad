-- Ejecutar una vez mediante Supabase CLI o SQL Editor, en el proyecto nuevo.
-- No modifica auth.sqlite ni copia cuentas del sistema anterior.
begin;

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

create table public.notebooks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index notebooks_owner_updated_idx on public.notebooks (owner_id, updated_at desc, id);

create function public.touch_notebook_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
create trigger notebooks_updated_at before update on public.notebooks
  for each row execute function public.touch_notebook_updated_at();

alter table public.notebooks enable row level security;
alter table public.notebooks force row level security;

create policy notebooks_select_own on public.notebooks for select to authenticated
  using (owner_id = (select auth.uid()));
create policy notebooks_insert_own on public.notebooks for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy notebooks_update_own on public.notebooks for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy notebooks_delete_own on public.notebooks for delete to authenticated
  using (owner_id = (select auth.uid()));

revoke all on public.notebooks from public, anon, authenticated;
grant select, delete on public.notebooks to authenticated;
grant insert (owner_id, title, description) on public.notebooks to authenticated;
grant update (title, description) on public.notebooks to authenticated;

-- Reserva del bucket para la siguiente etapa. Privado y sin permisos de objetos:
-- ni siquiera un usuario autenticado puede subir/leer archivos hasta agregar las
-- políticas que validen propietario Y cuaderno. No se exponen URLs públicas.
insert into storage.buckets (id, name, public)
values ('notebook-sources', 'notebook-sources', false)
on conflict (id) do nothing;
do $$ begin
  if exists (select 1 from storage.buckets where id = 'notebook-sources' and public) then
    raise exception 'El bucket notebook-sources existente es público. Revisar antes de continuar.';
  end if;
end $$;

-- No se crean columnas vector(N): la dimensión depende del embedding pendiente.
commit;
