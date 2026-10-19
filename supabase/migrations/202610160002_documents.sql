-- Segunda etapa. Ejecutar DESPUÉS de 202610160001_notebooks.sql.
-- No genera embeddings ni activa procesamiento de documentos.
begin;

alter table public.notebooks add constraint notebooks_id_owner_unique unique (id, owner_id);
create table public.documents (
  id uuid primary key,
  notebook_id uuid not null,
  owner_id uuid not null references auth.users(id),
  filename text not null check (char_length(filename) between 1 and 180),
  extension text not null check (extension in ('pdf', 'txt', 'md')),
  mime_type text not null check (mime_type in ('application/pdf', 'text/plain', 'text/markdown')),
  byte_size integer not null check (byte_size between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  object_path text generated always as (owner_id::text || '/' || notebook_id::text || '/' || id::text || '.' || extension) stored,
  status text not null default 'uploading' check (status in ('uploading', 'uploaded', 'processing', 'ready', 'error', 'deleting', 'deleted')),
  error_message text check (char_length(error_message) <= 1000),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  foreign key (notebook_id, owner_id) references public.notebooks (id, owner_id) on delete cascade,
  unique (object_path)
);
create index documents_notebook_owner_idx on public.documents (notebook_id, owner_id, created_at desc);
alter table public.documents enable row level security;
alter table public.documents force row level security;
create policy documents_read_own on public.documents for select to authenticated
  using (owner_id = (select auth.uid()));
create policy documents_insert_own on public.documents for insert to authenticated
  with check (owner_id = (select auth.uid()) and status = 'uploading'
    and exists (select 1 from public.notebooks n where n.id = notebook_id and n.owner_id = (select auth.uid())));
revoke all on public.documents from public, anon, authenticated;
grant select on public.documents to authenticated;
grant insert (id, notebook_id, owner_id, filename, extension, mime_type, byte_size, sha256) on public.documents to authenticated;
-- Los usuarios no pueden fingir status=ready ni cambiar la ruta del original.
-- Las transiciones siguientes comprueban estado y archivo, además del propietario.

create function public.complete_document_upload(document_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.documents;
begin
  select * into d from public.documents where id = document_id and owner_id = auth.uid() for update;
  if not found then raise exception 'Document not found' using errcode = 'P0002'; end if;
  if d.status <> 'uploading' then raise exception 'Invalid document state' using errcode = '55000'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'notebook-sources' and name = d.object_path) then
    raise exception 'Object missing' using errcode = '55000';
  end if;
  update public.documents set status = 'uploaded', error_message = null where id = d.id;
end;
$$;

create function public.fail_document_upload(document_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.documents set status = 'error', error_message = 'La subida no pudo completarse. Eliminá esta fuente y volvé a subirla.'
  where id = document_id and owner_id = auth.uid() and status = 'uploading';
end;
$$;

create function public.begin_document_delete(document_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.documents set status = 'deleting', error_message = null
  where id = document_id and owner_id = auth.uid() and status <> 'deleted';
  if not found then raise exception 'Document not found' using errcode = 'P0002'; end if;
end;
$$;

create function public.complete_document_delete(document_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.documents;
begin
  select * into d from public.documents where id = document_id and owner_id = auth.uid() for update;
  if not found then raise exception 'Document not found' using errcode = 'P0002'; end if;
  if d.status <> 'deleting' or exists (select 1 from storage.objects where bucket_id = 'notebook-sources' and name = d.object_path) then
    raise exception 'Object deletion pending' using errcode = '55000';
  end if;
  update public.documents set status = 'deleted', deleted_at = now(), error_message = null where id = d.id;
end;
$$;

-- Sólo se borra un cuaderno cuando sus fuentes ya fueron eliminadas de Storage.
-- Se toma un lock antes de comprobarlo para serializar nuevas inserciones/FKs.
create function public.delete_empty_notebook(notebook_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.notebooks where id = notebook_id and owner_id = auth.uid() for update;
  if not found then raise exception 'Notebook not found' using errcode = 'P0002'; end if;
  if exists (select 1 from public.documents where public.documents.notebook_id = delete_empty_notebook.notebook_id and status <> 'deleted') then
    raise exception 'Delete sources first' using errcode = '55000';
  end if;
  delete from public.notebooks where id = notebook_id and owner_id = auth.uid();
end;
$$;
revoke delete on public.notebooks from authenticated;
revoke all on function public.complete_document_upload(uuid), public.fail_document_upload(uuid),
  public.begin_document_delete(uuid), public.complete_document_delete(uuid), public.delete_empty_notebook(uuid) from public;
grant execute on function public.complete_document_upload(uuid), public.fail_document_upload(uuid),
  public.begin_document_delete(uuid), public.complete_document_delete(uuid), public.delete_empty_notebook(uuid) to authenticated;

-- El identificador aleatorio del archivo y su ruta proceden de una fila propia.
-- Sin política UPDATE: no se permite sobrescribir los originales.
create policy source_objects_read_own on storage.objects for select to authenticated using (
  bucket_id = 'notebook-sources' and exists (select 1 from public.documents d
    where d.object_path = name and d.owner_id = (select auth.uid()) and d.status <> 'deleted')
);
create policy source_objects_insert_own on storage.objects for insert to authenticated with check (
  bucket_id = 'notebook-sources' and exists (select 1 from public.documents d
    where d.object_path = name and d.owner_id = (select auth.uid()) and d.status = 'uploading')
);
create policy source_objects_delete_own on storage.objects for delete to authenticated using (
  bucket_id = 'notebook-sources' and exists (select 1 from public.documents d
    where d.object_path = name and d.owner_id = (select auth.uid()) and d.status = 'deleting')
);
do $$ begin
  if exists (select 1 from storage.buckets where id = 'notebook-sources' and public) then
    raise exception 'notebook-sources debe ser privado';
  end if;
end $$;
update storage.buckets set file_size_limit = 10485760,
  allowed_mime_types = array['application/pdf','text/plain','text/markdown']
where id = 'notebook-sources';
commit;
