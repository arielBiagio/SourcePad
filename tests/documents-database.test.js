import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

test('migración documental: RLS de documentos/Storage, estados y borrado seguro', async () => {
  const db = new PGlite({ extensions: { vector } });
  const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const doc = '33333333-3333-4333-8333-333333333333';
  const login = async user => {
    await db.exec('reset role; set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user]);
  };
  try {
    await db.exec(`
      create role anon nologin; create role authenticated nologin;
      create schema auth; create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
      grant usage on schema public, auth to authenticated, anon;
      create schema storage;
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, unique (bucket_id,name));
      alter table storage.objects enable row level security;
      alter table storage.objects force row level security;
      grant usage on schema storage to authenticated, anon;
      grant select,insert,delete on storage.objects to authenticated;
      insert into auth.users(id) values ('${a}'), ('${b}');
    `);
    for (const migration of ['202610160001_notebooks.sql', '202610160002_documents.sql']) {
      await db.exec(await readFile(new URL('../supabase/migrations/' + migration, import.meta.url), 'utf8'));
    }
    await login(a);
    // El id se genera por defecto en los cuadernos.
    const created = await db.query('insert into public.notebooks(owner_id,title) values ($1,$2) returning id', [a, 'Cuaderno A']);
    const notebookA = created.rows[0].id;
    await login(b);
    const notebookB = (await db.query('insert into public.notebooks(owner_id,title) values ($1,$2) returning id', [b, 'Cuaderno B'])).rows[0].id;
    await login(a);
    const insert = 'insert into public.documents(id,notebook_id,owner_id,filename,extension,mime_type,byte_size,sha256) values ($1,$2,$3,$4,$5,$6,$7,$8) returning object_path,status';
    const input = [doc, notebookA, a, 'notas.txt', 'txt', 'text/plain', 5, '0'.repeat(64)];
    const source = (await db.query(insert, input)).rows[0];
    const path = source.object_path;
    assert.equal(path, a + '/' + notebookA + '/' + doc + '.txt');
    assert.equal(source.status, 'uploading');
    await assert.rejects(db.query('update public.documents set status=$1 where id=$2', ['ready', doc]), /permission denied/);
    await assert.rejects(db.query('select public.complete_document_upload($1)', [doc]), /Object missing/);
    await assert.rejects(db.query("insert into storage.objects(bucket_id,name) values ('notebook-sources',$1)", ['ruta-inventada']), /row-level security/);
    await db.query("insert into storage.objects(bucket_id,name) values ('notebook-sources',$1)", [path]);
    await db.query('select public.complete_document_upload($1)', [doc]);
    assert.equal((await db.query('select status from public.documents where id=$1', [doc])).rows[0].status, 'uploaded');
    await assert.rejects(db.query('select public.delete_empty_notebook($1)', [notebookA]), /Delete sources first/);
    await assert.rejects(db.query('delete from public.notebooks where id=$1', [notebookA]), /permission denied/);
    assert.equal((await db.query('delete from storage.objects where name=$1 returning id', [path])).rows.length, 0);
    await login(b);
    assert.equal((await db.query('select * from public.documents')).rows.length, 0);
    assert.equal((await db.query('select * from storage.objects')).rows.length, 0);
    await assert.rejects(db.query('select public.begin_document_delete($1)', [doc]), /Document not found/);
    await assert.rejects(db.query(insert, ['44444444-4444-4444-8444-444444444444', notebookA, b, 'ataque.txt', 'txt', 'text/plain', 5, '1'.repeat(64)]), /row-level security/);
    await assert.rejects(db.query(insert, ['55555555-5555-4555-8555-555555555555', notebookB, a, 'ataque.txt', 'txt', 'text/plain', 5, '2'.repeat(64)]), /row-level security/);
    await login(a);
    await db.query('select public.begin_document_delete($1)', [doc]);
    await assert.rejects(db.query('select public.complete_document_delete($1)', [doc]), /Object deletion pending/);
    assert.equal((await db.query('delete from storage.objects where name=$1 returning id', [path])).rows.length, 1);
    await db.query('select public.complete_document_delete($1)', [doc]);
    const deleted = (await db.query('select status,deleted_at from public.documents where id=$1', [doc])).rows[0];
    assert.equal(deleted.status, 'deleted');
    assert.ok(deleted.deleted_at);
    await db.query('select public.delete_empty_notebook($1)', [notebookA]);
    assert.equal((await db.query('select id from public.notebooks where id=$1', [notebookA])).rows.length, 0);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select * from public.documents'), /permission denied/);
    await assert.rejects(db.query('select public.begin_document_delete($1)', [doc]), /permission denied/);
  } finally { await db.close(); }
});
