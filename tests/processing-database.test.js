import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

test('extracción SQL: RLS, guardado atómico, leases, reintentos y cancelación al borrar', async () => {
  const db = new PGlite({ extensions: { vector } });
  const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const doc = '33333333-3333-4333-8333-333333333333';
  const login = async user => {
    await db.exec('reset role; set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user]);
  };
  const complete = (run, chunks = [{ page_number: 2, content: 'Texto 📝', char_start: 0, char_end: 7 }]) =>
    db.query('select public.complete_document_processing($1,$2,$3,$4)', [doc, run, 3, JSON.stringify(chunks)]);
  try {
    await db.exec(`create role anon nologin; create role authenticated nologin;
      create schema auth; create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
      grant usage on schema public, auth to authenticated, anon;
      create schema storage;
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, unique (bucket_id,name));
      alter table storage.objects enable row level security;
      grant usage on schema storage to authenticated, anon;
      grant select,insert,delete on storage.objects to authenticated;
      insert into auth.users(id) values ('${a}'), ('${b}');`);
    for (const name of ['202610160001_notebooks.sql','202610160002_documents.sql','202610160003_processing.sql']) {
      await db.exec(await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8'));
    }
    await login(a);
    const notebook = (await db.query('insert into public.notebooks(owner_id,title) values ($1,$2) returning id', [a,'Proceso A'])).rows[0].id;
    const path = (await db.query('insert into public.documents(id,notebook_id,owner_id,filename,extension,mime_type,byte_size,sha256) values ($1,$2,$3,$4,$5,$6,$7,$8) returning object_path', [doc,notebook,a,'demo.pdf','pdf','application/pdf',100,'0'.repeat(64)])).rows[0].object_path;
    await assert.rejects(db.query('select public.begin_document_processing($1)', [doc]), /Invalid state/);
    await db.query("insert into storage.objects(bucket_id,name) values ('notebook-sources',$1)", [path]);
    await db.query('select public.complete_document_upload($1)', [doc]);
    const begin = () => db.query('select public.begin_document_processing($1) as job', [doc]);
    const first = (await begin()).rows[0].job;
    assert.equal(first.attempts, 1);
    await assert.rejects(begin(), /Already processing/);
    await assert.rejects(db.query("update public.documents set status='extracted' where id=$1", [doc]), /permission denied/);
    await assert.rejects(db.query('delete from public.document_jobs'), /permission denied/);
    await assert.rejects(complete(first.run_id, [{ page_number: 4, content: 'Mala', char_start: 0, char_end: 4 }]), /Invalid chunk/);
    assert.equal((await db.query('select status from public.document_jobs')).rows[0].status, 'running');
    await login(b);
    assert.equal((await db.query('select * from public.document_jobs')).rows.length, 0);
    await assert.rejects(begin(), /Document not found/);
    await assert.rejects(complete(first.run_id), /Document not found/);
    await assert.rejects(db.query('select public.fail_document_processing($1,$2,$3)', [doc,first.run_id,'NO_TEXT']), /Document not found/);
    await login(a);
    await db.query('select public.fail_document_processing($1,$2,$3)', [doc,first.run_id,'NO_TEXT']);
    assert.match((await db.query('select error_message from public.documents where id=$1', [doc])).rows[0].error_message, /OCR/);
    const second = (await begin()).rows[0].job;
    assert.equal(second.attempts, 2);
    await assert.rejects(complete(first.run_id), /Expired or cancelled/);
    // Simular caída del servidor: sólo un lease vencido puede retomarse.
    await db.exec('reset role');
    await db.query("update public.document_jobs set lease_until=now()-interval '1 second' where document_id=$1", [doc]);
    await login(a);
    await assert.rejects(complete(second.run_id), /Expired or cancelled/);
    const third = (await begin()).rows[0].job;
    assert.equal(third.attempts, 3);
    // Dos chunks: si el segundo falla, tampoco persiste el primero.
    await assert.rejects(complete(third.run_id, [
      { page_number: 1, content: 'Uno', char_start: 0, char_end: 3 },
      { page_number: 2, content: 'Dos', char_start: 0, char_end: 99 },
    ]), /check constraint/);
    await db.exec('reset role');
    assert.equal((await db.query('select * from public.document_chunks')).rows.length, 0);
    await login(a);
    await complete(third.run_id);
    const result = (await db.query('select status,page_count,empty_page_count,chunk_count from public.documents where id=$1', [doc])).rows[0];
    assert.deepEqual(result, { status: 'extracted', page_count: 3, empty_page_count: 2, chunk_count: 1 });
    assert.equal((await db.query('select content from public.document_chunks')).rows[0].content, 'Texto 📝');
    await assert.rejects(begin(), /Invalid state/);
    await login(b);
    assert.equal((await db.query('select * from public.document_chunks')).rows.length, 0);
    await login(a);
    await db.query('select public.begin_document_delete($1)', [doc]);
    assert.equal((await db.query('select * from public.document_chunks')).rows.length, 0);
    await assert.rejects(complete(third.run_id), /Expired or cancelled/);
    await db.query('delete from storage.objects where name=$1', [path]);
    await db.query('select public.complete_document_delete($1)', [doc]);
    await db.query('select public.delete_empty_notebook($1)', [notebook]);
    assert.equal((await db.query('select * from public.document_jobs')).rows.length, 0);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select * from public.document_chunks'), /permission denied/);
    await assert.rejects(begin(), /permission denied/);
  } finally { await db.close(); }
});
