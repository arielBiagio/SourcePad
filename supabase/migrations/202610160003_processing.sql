-- Tercera etapa: extracción/fragmentación bajo demanda. Aplicar después de 001 y 002.
-- No genera embeddings, no modifica originales y no llama a servicios de IA.
begin;

alter table public.documents drop constraint documents_status_check;
alter table public.documents add constraint documents_status_check
  check (status in ('uploading','uploaded','processing','extracted','ready','error','deleting','deleted'));
alter table public.documents add column page_count integer check (page_count between 1 and 200),
  add column empty_page_count integer not null default 0 check (empty_page_count between 0 and 200),
  add column chunk_count integer not null default 0 check (chunk_count between 0 and 1500),
  add column processed_at timestamptz,
  add column processing_version text;
alter table public.documents add constraint documents_identity_unique unique (id, notebook_id, owner_id);

create table public.document_jobs (
  document_id uuid primary key,
  notebook_id uuid not null,
  owner_id uuid not null,
  status text not null check (status in ('running','succeeded','failed','cancelled')),
  run_id uuid not null,
  attempts integer not null default 1 check (attempts > 0),
  lease_until timestamptz,
  error_code text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (document_id, notebook_id, owner_id) references public.documents(id, notebook_id, owner_id) on delete cascade
);
create table public.document_chunks (
  document_id uuid not null,
  notebook_id uuid not null,
  owner_id uuid not null,
  position integer not null check (position between 0 and 1499),
  page_number integer check (page_number between 1 and 200),
  content text not null check (char_length(btrim(content)) > 0 and char_length(content) <= 1200),
  char_start integer not null check (char_start >= 0),
  char_end integer not null,
  version text not null,
  primary key (document_id, position),
  check (char_end - char_start = char_length(content)),
  foreign key (document_id, notebook_id, owner_id) references public.documents(id, notebook_id, owner_id) on delete cascade
);
create index document_chunks_scope_idx on public.document_chunks(owner_id, notebook_id, document_id);
alter table public.document_jobs enable row level security;
alter table public.document_jobs force row level security;
alter table public.document_chunks enable row level security;
alter table public.document_chunks force row level security;
create policy jobs_read_own on public.document_jobs for select to authenticated using (owner_id = (select auth.uid()));
create policy chunks_read_own on public.document_chunks for select to authenticated using (
  owner_id = (select auth.uid()) and exists (select 1 from public.documents d
    where d.id = document_id and d.status in ('extracted','ready'))
);
revoke all on public.document_jobs, public.document_chunks from public, anon, authenticated;
grant select on public.document_jobs, public.document_chunks to authenticated;

-- Lock del documento primero en TODAS las transiciones. Un run_id nuevo invalida
-- trabajadores atrasados. Lease de 2 minutos; después de un reinicio se reintenta
-- explícitamente, no se almacena un JWT para ejecutar tareas sin sesión.
create function public.begin_document_processing(document_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.documents; j public.document_jobs;
begin
  select * into d from public.documents where id = document_id and owner_id = auth.uid() for update;
  if not found then raise exception 'Document not found' using errcode = 'P0002'; end if;
  if d.status not in ('uploaded','error','processing') then raise exception 'Invalid state' using errcode = '55000'; end if;
  if not exists (select 1 from storage.objects where bucket_id = 'notebook-sources' and name = d.object_path) then
    raise exception 'Original missing' using errcode = '55000';
  end if;
  select * into j from public.document_jobs where public.document_jobs.document_id = d.id;
  if j.status = 'running' and j.lease_until > now() then raise exception 'Already processing' using errcode = '55000'; end if;
  insert into public.document_jobs(document_id,notebook_id,owner_id,status,run_id,lease_until)
    values(d.id,d.notebook_id,d.owner_id,'running',gen_random_uuid(),now() + interval '2 minutes')
    on conflict on constraint document_jobs_pkey do update set
      status = 'running', run_id = gen_random_uuid(), attempts = public.document_jobs.attempts + 1,
      lease_until = now() + interval '2 minutes', error_code = null, started_at = now(), finished_at = null
    returning * into j;
  update public.documents set status = 'processing', error_message = null, processing_version = 'text-v1-char1200-overlap180' where id = d.id;
  return jsonb_build_object('run_id',j.run_id,'attempts',j.attempts);
end;
$$;

create function public.complete_document_processing(document_id uuid, processing_run uuid, page_total integer, chunks jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.documents; j public.document_jobs; item jsonb; idx integer := 0;
  p integer; s integer; e integer; body text; previous_page integer := 0; previous_start integer := -1;
begin
  select * into d from public.documents where id = document_id and owner_id = auth.uid() for update;
  if not found then raise exception 'Document not found' using errcode = 'P0002'; end if;
  select * into j from public.document_jobs where public.document_jobs.document_id = d.id;
  if d.status <> 'processing' or j.status is distinct from 'running' or j.run_id is distinct from processing_run or j.lease_until <= now() then
    raise exception 'Expired or cancelled job' using errcode = '55000';
  end if;
  if (d.extension = 'pdf' and (page_total is null or page_total not between 1 and 200))
    or (d.extension <> 'pdf' and page_total is not null)
    or jsonb_typeof(chunks) is distinct from 'array' then raise exception 'Invalid extraction' using errcode = '22023'; end if;
  if jsonb_array_length(chunks) not between 1 and 1500 or octet_length(chunks::text) > 8388608 then
    raise exception 'Extraction too large' using errcode = '22023';
  end if;
  delete from public.document_chunks where public.document_chunks.document_id = d.id;
  for item in select value from jsonb_array_elements(chunks) loop
    p := (item->>'page_number')::integer; s := (item->>'char_start')::integer;
    e := (item->>'char_end')::integer; body := item->>'content';
    if jsonb_typeof(item->'content') is distinct from 'string' or body ~ '[\x01-\x08\x0b\x0c\x0e-\x1f]'
      or (d.extension = 'pdf' and (p is null or p not between 1 and page_total))
      or (d.extension <> 'pdf' and p is not null)
      or coalesce(p,0) < previous_page or (coalesce(p,0) = previous_page and s <= previous_start)
      then raise exception 'Invalid chunk' using errcode = '22023'; end if;
    insert into public.document_chunks(document_id,notebook_id,owner_id,position,page_number,content,char_start,char_end,version)
      values(d.id,d.notebook_id,d.owner_id,idx,p,body,s,e,d.processing_version);
    previous_page := coalesce(p,0); previous_start := s; idx := idx + 1;
  end loop;
  if (select sum(char_length(content)) from public.document_chunks where public.document_chunks.document_id = d.id) > 1400000 then
    raise exception 'Extraction too large' using errcode = '22023';
  end if;
  update public.documents set status = 'extracted', page_count = page_total, chunk_count = idx,
    empty_page_count = case when page_total is null then 0 else page_total - (select count(distinct page_number) from public.document_chunks where public.document_chunks.document_id = d.id) end,
    processed_at = now(), error_message = null where id = d.id;
  update public.document_jobs set status = 'succeeded', lease_until = null, finished_at = now(), error_code = null where public.document_jobs.document_id = d.id;
end;
$$;

create function public.fail_document_processing(document_id uuid, processing_run uuid, failure_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.documents; message text;
begin
  select * into d from public.documents where id = document_id and owner_id = auth.uid() for update;
  if not found then raise exception 'Document not found' using errcode = 'P0002'; end if;
  if d.status <> 'processing' or not exists (select 1 from public.document_jobs j where j.document_id = d.id and j.status = 'running' and j.run_id = processing_run) then return; end if;
  message := case failure_code
    when 'NO_TEXT' then 'No se encontró texto seleccionable. Si es un escaneo, necesita OCR (todavía no disponible).'
    when 'PDF_PASSWORD' then 'El PDF está protegido con contraseña. Subí una copia sin protección.'
    when 'INVALID_FILE' then 'No se pudo leer el archivo. Revisá que no esté dañado y volvé a subirlo.'
    when 'LIMIT_EXCEEDED' then 'El documento supera los límites de procesamiento. Dividilo en archivos más pequeños.'
    when 'TIMEOUT' then 'El procesamiento tardó demasiado. Podés reintentarlo o dividir el archivo.'
    when 'INTEGRITY' then 'El original no coincide con la subida registrada. Eliminá la fuente y volvé a subirla.'
    else 'No se pudo procesar el documento. Intentá nuevamente.' end;
  update public.documents set status = 'error', error_message = message where id = d.id;
  update public.document_jobs set status = 'failed', error_code = left(coalesce(failure_code,'PROCESSING_FAILED'),60), lease_until = null, finished_at = now() where public.document_jobs.document_id = d.id;
end;
$$;

-- Cancelar el trabajo y retirar el texto derivado al comenzar un borrado.
-- Un resultado atrasado no puede revivir ni volver a escribir una fuente borrada.
create or replace function public.begin_document_delete(document_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.documents;
begin
  select * into d from public.documents where id = document_id and owner_id = auth.uid() for update;
  if not found or d.status = 'deleted' then raise exception 'Document not found' using errcode = 'P0002'; end if;
  update public.documents set status = 'deleting', error_message = null, chunk_count = 0, page_count = null, empty_page_count = 0, processed_at = null where id = d.id;
  update public.document_jobs set status = 'cancelled', lease_until = null, finished_at = now() where public.document_jobs.document_id = d.id and status = 'running';
  delete from public.document_chunks where public.document_chunks.document_id = d.id;
end;
$$;
revoke all on function public.begin_document_processing(uuid), public.complete_document_processing(uuid,uuid,integer,jsonb),
  public.fail_document_processing(uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.begin_document_processing(uuid), public.complete_document_processing(uuid,uuid,integer,jsonb),
  public.fail_document_processing(uuid,uuid,text) to authenticated;
commit;
