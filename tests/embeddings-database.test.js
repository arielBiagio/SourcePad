import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

test('BGE-M3 SQL: 1024 dimensiones, lotes atómicos/reanudables, búsqueda exacta y RLS', async () => {
  const db = new PGlite({ extensions: { vector } });
  const a = randomUUID(), b = randomUUID();
  const unit = axis => Array.from({ length: 1024 }, (_, i) => Number(i === axis));
  const login = async user => {
    await db.exec('reset role; set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  };
  try {
    await db.exec(`create role anon nologin; create role authenticated nologin;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as 'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
      grant usage on schema public,auth to authenticated,anon;
      create schema storage;
      create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text,unique(bucket_id,name));
      alter table storage.objects enable row level security;
      grant usage on schema storage to authenticated,anon;
      grant select,insert,delete on storage.objects to authenticated;`);
    await db.query('insert into auth.users values ($1),($2)', [a,b]);
    for (const file of ['202610160001_notebooks.sql','202610160002_documents.sql','202610160003_processing.sql','202610160004_embeddings.sql']) {
      await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url),'utf8'));
    }
    const book = async owner => (await db.query('insert into public.notebooks(owner_id,title) values ($1,$2) returning id',[owner,'Prueba'])).rows[0].id;
    const source = async (owner, notebook, count = 35) => {
      const id = randomUUID();
      const path = (await db.query('insert into public.documents(id,notebook_id,owner_id,filename,extension,mime_type,byte_size,sha256) values($1,$2,$3,$4,$5,$6,$7,$8) returning object_path',[id,notebook,owner,'notas.txt','txt','text/plain',10,'0'.repeat(64)])).rows[0].object_path;
      await db.query("insert into storage.objects(bucket_id,name) values ('notebook-sources',$1)",[path]);
      await db.query('select public.complete_document_upload($1)',[id]);
      const job = (await db.query('select public.begin_document_processing($1) as job',[id])).rows[0].job;
      const chunks = Array.from({ length: count }, (_, position) => ({ page_number: null, content: 'Fragmento ' + position, char_start: position * 20, char_end: position * 20 + ('Fragmento ' + position).length }));
      await db.query('select public.complete_document_processing($1,$2,null,$3)',[id,job.run_id,JSON.stringify(chunks)]);
      return { id,path };
    };
    const begin = async id => (await db.query('select public.begin_document_indexing($1) as job',[id])).rows[0].job;
    const payload = chunks => chunks.map(c => ({ position: c.position, content_sha256: createHash('sha256').update(c.content).digest('hex'), embedding: unit(c.position === 0 ? 0 : 1) }));
    const save = (id,job,items = payload(job.chunks)) => db.query('select public.store_document_embeddings($1,$2,$3)',[id,job.run_id,JSON.stringify(items)]);
    const search = (notebook, ids = null, embedding = unit(0)) => db.query('select * from public.match_notebook_chunks($1,$2,$3,5)',[notebook,JSON.stringify(embedding),ids]);
    await login(a);
    const bookA = await book(a), otherA = await book(a);
    const doc = await source(a,bookA);
    assert.equal((await search(bookA)).rows.length, 0);
    const first = await begin(doc.id);
    assert.equal(first.chunks.length, 32);
    await assert.rejects(begin(doc.id), /Already indexing/);
    const wrong = payload(first.chunks); wrong[1].embedding = [1,0];
    await assert.rejects(save(doc.id,first,wrong), /Invalid vector dimensions/);
    assert.equal((await db.query('select * from public.chunk_embeddings')).rows.length, 0);
    const zero = payload(first.chunks); zero[0].embedding = Array(1024).fill(0);
    await assert.rejects(save(doc.id,first,zero), /check constraint/);
    await save(doc.id,first);
    assert.equal((await db.query('select index_status from public.documents where id=$1',[doc.id])).rows[0].index_status,'partial');
    assert.equal((await search(bookA)).rows.length,0); // Los resultados parciales no son consultables.
    const second = await begin(doc.id);
    assert.deepEqual(second.chunks.map(c => c.position),[32,33,34]);
    await db.query('select public.fail_document_indexing($1,$2,$3)',[doc.id,second.run_id,'EMBEDDINGS_CREDITS']);
    assert.equal((await db.query('select count(*)::int as n from public.chunk_embeddings')).rows[0].n,32);
    const retry = await begin(doc.id);
    await assert.rejects(save(doc.id,second), /Expired or cancelled/);
    const stale = payload(retry.chunks); stale[0].content_sha256 = '1'.repeat(64);
    await assert.rejects(save(doc.id,retry,stale), /Stale chunk/);
    await save(doc.id,retry);
    assert.equal((await begin(doc.id)).complete,true);
    const matched = (await search(bookA)).rows;
    assert.equal(matched.length,5); assert.equal(matched[0].position,0); assert.equal(matched[0].similarity,1);
    assert.equal(matched[0].content,'Fragmento 0');
    assert.equal((await search(otherA)).rows.length,0);
    await assert.rejects(search(otherA,[doc.id]), /Source not found/);
    await assert.rejects(search(bookA,[],unit(0)), /Source not found/);
    await assert.rejects(search(bookA,null,[1,0]), /Invalid search/);
    await assert.rejects(db.query('update public.chunk_embeddings set profile=$1',['other']), /permission denied/);
    await login(b);
    const bookB = await book(b);
    assert.equal((await db.query('select * from public.chunk_embeddings')).rows.length,0);
    assert.equal((await db.query('select * from public.document_embedding_jobs')).rows.length,0);
    await assert.rejects(begin(doc.id), /Document not found/);
    await assert.rejects(search(bookA), /Notebook not found/);
    await assert.rejects(search(bookB,[doc.id]), /Source not found/);
    const bDoc = await source(b,bookB,1); const bJob = await begin(bDoc.id); await save(bDoc.id,bJob);
    assert.equal((await search(bookB)).rows[0].document_id,bDoc.id);
    await login(a);
    assert.ok((await search(bookA)).rows.every(row => row.document_id === doc.id));
    // Lease vencido + borrado durante un lote: ni el worker antiguo ni el nuevo reviven la fuente.
    const cancelled = await source(a,bookA,1); const oldJob = await begin(cancelled.id);
    await db.exec('reset role');
    await db.query("update public.document_embedding_jobs set lease_until=now()-interval '1 second' where document_id=$1",[cancelled.id]);
    await login(a);
    await assert.rejects(save(cancelled.id,oldJob), /Expired or cancelled/);
    const newJob = await begin(cancelled.id);
    await db.query('select public.begin_document_delete($1)',[cancelled.id]);
    await assert.rejects(save(cancelled.id,newJob), /Expired or cancelled/);
    await db.query('select public.begin_document_delete($1)',[doc.id]);
    assert.equal((await db.query('select * from public.chunk_embeddings')).rows.length,0);
    assert.equal((await search(bookA)).rows.length,0);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select * from public.chunk_embeddings'), /permission denied/);
    await assert.rejects(begin(doc.id), /permission denied/);
    await assert.rejects(search(bookA), /permission denied/);
  } finally { await db.close(); }
});
