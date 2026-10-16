-- BGE-M3 dense 1024 + búsqueda exacta por coseno. Requiere 001, 002 y 003.
-- Sólo crea estructura/funciones: NO genera llamadas externas ni indexa archivos.
begin;
grant usage on schema extensions to authenticated;
alter table public.documents add column index_status text not null default 'not_indexed'
    check (index_status in ('not_indexed','indexing','partial','indexed','error')),
  add column indexed_chunk_count integer not null default 0 check (indexed_chunk_count between 0 and 1500),
  add column embedding_profile text,
  add column embedded_at timestamptz,
  add column embedding_error text check (char_length(embedding_error) <= 1000);

create table public.chunk_embeddings (
  document_id uuid not null,
  position integer not null,
  notebook_id uuid not null,
  owner_id uuid not null,
  profile text not null check (profile = 'baai/bge-m3:dense:1024:cosine:v1'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  embedding extensions.vector(1024) not null check (extensions.vector_norm(embedding) between 0.999 and 1.001),
  created_at timestamptz not null default now(),
  primary key (document_id,position,profile),
  foreign key (document_id,position) references public.document_chunks(document_id,position) on delete cascade,
  foreign key (document_id,notebook_id,owner_id) references public.documents(id,notebook_id,owner_id) on delete cascade
);
create index chunk_embeddings_scope_idx on public.chunk_embeddings(owner_id,notebook_id,profile);
create table public.document_embedding_jobs (
  document_id uuid primary key,
  notebook_id uuid not null,
  owner_id uuid not null,
  status text not null check (status in ('running','pending','succeeded','failed','cancelled')),
  run_id uuid not null,
  attempts integer not null default 1,
  lease_until timestamptz,
  pending_positions integer[],
  error_code text,
  updated_at timestamptz not null default now(),
  foreign key (document_id,notebook_id,owner_id) references public.documents(id,notebook_id,owner_id) on delete cascade
);
alter table public.chunk_embeddings enable row level security;
alter table public.chunk_embeddings force row level security;
alter table public.document_embedding_jobs enable row level security;
alter table public.document_embedding_jobs force row level security;
create policy embeddings_read_own on public.chunk_embeddings for select to authenticated using (
  owner_id = (select auth.uid()) and exists(select 1 from public.documents d where d.id = document_id and d.status in ('extracted','ready'))
);
create policy embedding_jobs_read_own on public.document_embedding_jobs for select to authenticated using (owner_id = (select auth.uid()));
revoke all on public.chunk_embeddings, public.document_embedding_jobs from public, anon, authenticated;
grant select on public.chunk_embeddings, public.document_embedding_jobs to authenticated;

-- Un reclamo = un lote de hasta 32 fragmentos. Los lotes guardados no se repiten.
create function public.begin_document_indexing(document_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.documents; j public.document_embedding_jobs; todo jsonb;
begin
  select * into d from public.documents where id = document_id and owner_id = auth.uid() for update;
  if not found then raise exception 'Document not found' using errcode = 'P0002'; end if;
  if d.status not in ('extracted','ready') or d.chunk_count < 1 then raise exception 'Extract text first' using errcode = '55000'; end if;
  select * into j from public.document_embedding_jobs where public.document_embedding_jobs.document_id = d.id;
  if j.status = 'running' and j.lease_until > now() then raise exception 'Already indexing' using errcode = '55000'; end if;
  select jsonb_agg(to_jsonb(p) order by p.position) into todo from (
    select c.position,c.content,encode(sha256(convert_to(c.content,'UTF8')),'hex') as content_sha256
    from public.document_chunks c where c.document_id = d.id and c.version = d.processing_version
    and not exists(select 1 from public.chunk_embeddings e where e.document_id = c.document_id and e.position = c.position
      and e.profile = 'baai/bge-m3:dense:1024:cosine:v1' and e.content_sha256 = encode(sha256(convert_to(c.content,'UTF8')),'hex'))
    order by c.position limit 32
  ) p;
  if todo is null then
    if (select count(*) from public.document_chunks c where c.document_id = d.id and c.version = d.processing_version) <> d.chunk_count then
      raise exception 'Missing chunks' using errcode = '55000';
    end if;
    update public.documents set status = 'ready', index_status = 'indexed', indexed_chunk_count = chunk_count,
      embedding_profile = 'baai/bge-m3:dense:1024:cosine:v1', embedded_at = coalesce(embedded_at,now()), embedding_error = null where id = d.id;
    update public.document_embedding_jobs set status = 'succeeded', lease_until = null, pending_positions = null, updated_at = now() where public.document_embedding_jobs.document_id = d.id;
    return jsonb_build_object('complete',true);
  end if;
  insert into public.document_embedding_jobs(document_id,notebook_id,owner_id,status,run_id,lease_until,pending_positions)
    values(d.id,d.notebook_id,d.owner_id,'running',gen_random_uuid(),now()+interval '2 minutes',array(select (value->>'position')::integer from jsonb_array_elements(todo)))
    on conflict on constraint document_embedding_jobs_pkey do update set status = 'running', run_id = gen_random_uuid(),
      attempts = public.document_embedding_jobs.attempts + 1, lease_until = now()+interval '2 minutes',
      pending_positions = excluded.pending_positions, error_code = null, updated_at = now()
    returning * into j;
  update public.documents set index_status = 'indexing', embedding_error = null where id = d.id;
  return jsonb_build_object('complete',false,'run_id',j.run_id,'chunks',todo);
end;
$$;

create function public.store_document_embeddings(document_id uuid, indexing_run uuid, items jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.documents; j public.document_embedding_jobs; item jsonb; c public.document_chunks;
  v extensions.vector(1024); seen integer[] := '{}'; total integer;
begin
  select * into d from public.documents where id = document_id and owner_id = auth.uid() for update;
  if not found then raise exception 'Document not found' using errcode = 'P0002'; end if;
  select * into j from public.document_embedding_jobs where public.document_embedding_jobs.document_id = d.id;
  if d.status not in ('extracted','ready') or j.status is distinct from 'running' or j.run_id is distinct from indexing_run or j.lease_until <= now() then
    raise exception 'Expired or cancelled job' using errcode = '55000';
  end if;
  if jsonb_typeof(items) is distinct from 'array' then raise exception 'Invalid batch' using errcode = '22023'; end if;
  if jsonb_array_length(items) <> cardinality(j.pending_positions) or jsonb_array_length(items) not between 1 and 32 then
    raise exception 'Invalid batch' using errcode = '22023';
  end if;
  for item in select value from jsonb_array_elements(items) loop
    if (item->>'position') is null or not ((item->>'position')::integer = any(j.pending_positions))
      or (item->>'position')::integer = any(seen) then raise exception 'Invalid position' using errcode = '22023'; end if;
    select * into c from public.document_chunks where public.document_chunks.document_id = d.id and position = (item->>'position')::integer;
    if not found or c.version <> d.processing_version or item->>'content_sha256' is distinct from encode(sha256(convert_to(c.content,'UTF8')),'hex') then
      raise exception 'Stale chunk' using errcode = '55000';
    end if;
    if jsonb_typeof(item->'embedding') is distinct from 'array' then raise exception 'Invalid vector' using errcode = '22023'; end if;
    if jsonb_array_length(item->'embedding') <> 1024 then raise exception 'Invalid vector dimensions' using errcode = '22023'; end if;
    v := (item->'embedding')::text::extensions.vector(1024);
    insert into public.chunk_embeddings(document_id,position,notebook_id,owner_id,profile,content_sha256,embedding)
      values(d.id,c.position,d.notebook_id,d.owner_id,'baai/bge-m3:dense:1024:cosine:v1',item->>'content_sha256',v)
      on conflict on constraint chunk_embeddings_pkey do update set content_sha256 = excluded.content_sha256, embedding = excluded.embedding, created_at = now();
    seen := array_append(seen,c.position);
  end loop;
  select count(*) into total from public.chunk_embeddings e join public.document_chunks saved_chunk on saved_chunk.document_id = e.document_id and saved_chunk.position = e.position
    where e.document_id = d.id and e.profile = 'baai/bge-m3:dense:1024:cosine:v1'
      and e.content_sha256 = encode(sha256(convert_to(saved_chunk.content,'UTF8')),'hex') and saved_chunk.version = d.processing_version;
  update public.documents set indexed_chunk_count = total, index_status = case when total = chunk_count then 'indexed' else 'partial' end,
    status = case when total = chunk_count then 'ready' else 'extracted' end,
    embedding_profile = 'baai/bge-m3:dense:1024:cosine:v1', embedded_at = case when total = chunk_count then now() else null end, embedding_error = null where id = d.id;
  update public.document_embedding_jobs set status = case when total = d.chunk_count then 'succeeded' else 'pending' end,
    lease_until = null, pending_positions = null, error_code = null, updated_at = now() where public.document_embedding_jobs.document_id = d.id;
end;
$$;

create function public.fail_document_indexing(document_id uuid, indexing_run uuid, failure_code text)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.documents;
begin
  select * into d from public.documents where id = document_id and owner_id = auth.uid() for update;
  if not found then raise exception 'Document not found' using errcode = 'P0002'; end if;
  if d.status not in ('extracted','ready') or not exists(select 1 from public.document_embedding_jobs j where j.document_id = d.id and j.status = 'running' and j.run_id = indexing_run) then return; end if;
  update public.documents set index_status = 'error', embedding_error = case failure_code
    when 'EMBEDDINGS_CREDITS' then 'OpenRouter no tiene saldo suficiente. Revisá tus créditos y reintentá.'
    when 'EMBEDDINGS_ACCESS' then 'OpenRouter rechazó la clave o sus permisos para embeddings.'
    else 'La indexación se interrumpió. Los lotes guardados se conservan; podés reintentar.' end where id = d.id;
  update public.document_embedding_jobs set status = 'failed', lease_until = null, pending_positions = null,
    error_code = left(coalesce(failure_code,'INDEXING_FAILED'),60), updated_at = now() where public.document_embedding_jobs.document_id = d.id;
end;
$$;

-- INVOKER: RLS y filtros explícitos. Un array ajeno/inactivo se rechaza entero.
create function public.notebook_indexed_source_count(notebook_id uuid, source_ids uuid[] default null)
returns integer language plpgsql security invoker set search_path = '' as $$
begin
  if not exists(select 1 from public.notebooks n where n.id = notebook_id and n.owner_id = auth.uid()) then
    raise exception 'Notebook not found' using errcode = 'P0002'; end if;
  if source_ids is not null and (cardinality(source_ids) not between 1 and 20
    or exists(select 1 from unnest(source_ids) s(id) where not exists(select 1 from public.documents d
      where d.id = s.id and d.notebook_id = notebook_indexed_source_count.notebook_id and d.owner_id = auth.uid()
        and d.status = 'ready' and d.index_status = 'indexed' and d.embedding_profile = 'baai/bge-m3:dense:1024:cosine:v1'))) then
    raise exception 'Source not found or not indexed' using errcode = 'P0002'; end if;
  return (select count(*)::integer from public.documents d where d.notebook_id = notebook_indexed_source_count.notebook_id and d.owner_id = auth.uid()
    and d.status = 'ready' and d.index_status = 'indexed' and d.embedding_profile = 'baai/bge-m3:dense:1024:cosine:v1'
    and (source_ids is null or d.id = any(source_ids)));
end;
$$;

create function public.match_notebook_chunks(notebook_id uuid, query_embedding extensions.vector(1024), source_ids uuid[] default null, match_limit integer default 5)
returns table(document_id uuid, filename text, "position" integer, page_number integer, content text, char_start integer, char_end integer, similarity double precision)
language plpgsql security invoker set search_path = '' as $$
begin
  perform public.notebook_indexed_source_count(notebook_id,source_ids);
  if match_limit not between 1 and 10 or match_limit is null or query_embedding is null
    or extensions.vector_dims(query_embedding) <> 1024 or extensions.vector_norm(query_embedding) not between 0.999 and 1.001 then
    raise exception 'Invalid search' using errcode = '22023'; end if;
  return query select c.document_id,d.filename,c.position,c.page_number,c.content,c.char_start,c.char_end,
    1 - (e.embedding operator(extensions.<=>) query_embedding) as similarity
    from public.chunk_embeddings e join public.document_chunks c on c.document_id = e.document_id and c.position = e.position
      join public.documents d on d.id = c.document_id
    where e.owner_id = auth.uid() and e.notebook_id = match_notebook_chunks.notebook_id
      and c.owner_id = auth.uid() and c.notebook_id = match_notebook_chunks.notebook_id
      and d.owner_id = auth.uid() and d.notebook_id = match_notebook_chunks.notebook_id
      and d.status = 'ready' and d.index_status = 'indexed' and c.version = d.processing_version
      and e.profile = 'baai/bge-m3:dense:1024:cosine:v1' and d.embedding_profile = e.profile
      and e.content_sha256 = encode(sha256(convert_to(c.content,'UTF8')),'hex')
      and (source_ids is null or d.id = any(source_ids))
    order by e.embedding operator(extensions.<=>) query_embedding,c.document_id,c.position limit match_limit;
end;
$$;

create or replace function public.begin_document_delete(document_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.documents;
begin
  select * into d from public.documents where id = document_id and owner_id = auth.uid() for update;
  if not found or d.status = 'deleted' then raise exception 'Document not found' using errcode = 'P0002'; end if;
  update public.documents set status = 'deleting', error_message = null, chunk_count = 0, page_count = null, empty_page_count = 0, processed_at = null,
    index_status = 'not_indexed', indexed_chunk_count = 0, embedding_profile = null, embedded_at = null, embedding_error = null where id = d.id;
  update public.document_jobs set status = 'cancelled', lease_until = null, finished_at = now() where public.document_jobs.document_id = d.id and status = 'running';
  update public.document_embedding_jobs set status = 'cancelled', lease_until = null, pending_positions = null, updated_at = now() where public.document_embedding_jobs.document_id = d.id;
  delete from public.document_chunks where public.document_chunks.document_id = d.id;
end;
$$;
revoke all on function public.begin_document_indexing(uuid), public.store_document_embeddings(uuid,uuid,jsonb), public.fail_document_indexing(uuid,uuid,text),
  public.notebook_indexed_source_count(uuid,uuid[]), public.match_notebook_chunks(uuid,extensions.vector,uuid[],integer) from public, anon, authenticated;
grant execute on function public.begin_document_indexing(uuid), public.store_document_embeddings(uuid,uuid,jsonb), public.fail_document_indexing(uuid,uuid,text),
  public.notebook_indexed_source_count(uuid,uuid[]), public.match_notebook_chunks(uuid,extensions.vector,uuid[],integer) to authenticated;
commit;
