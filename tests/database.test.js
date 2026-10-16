import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

test('la migración se ejecuta en PostgreSQL local y RLS aísla a dos usuarios', async () => {
  const db = new PGlite({ extensions: { vector } });
  const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  try {
    // Supabase crea estos roles, auth.uid y storage.buckets. Aquí sólo se simula
    // ese contexto; tablas, grants, triggers y RLS usan PostgreSQL real (WASM).
    await db.exec(`
      create role anon nologin;
      create role authenticated nologin;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
      grant usage on schema public, auth to authenticated, anon;
      grant execute on function auth.uid() to authenticated, anon;
      create schema storage;
      create table storage.buckets (id text primary key, name text, public boolean);
      insert into auth.users (id) values ('${a}'), ('${b}');
    `);
    await db.exec(await readFile(new URL('../supabase/migrations/202610160001_notebooks.sql', import.meta.url), 'utf8'));
    assert.equal((await db.query("select public from storage.buckets where id='notebook-sources'")).rows[0].public, false);
    assert.equal((await db.query("select extname from pg_extension where extname='vector'")).rows.length, 1);
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [a]);
    const inserted = await db.query('insert into public.notebooks (owner_id, title) values ($1,$2) returning id', [a, 'Privado de A']);
    const id = inserted.rows[0].id;
    assert.equal((await db.query('select * from public.notebooks')).rows.length, 1);
    assert.equal((await db.query('update public.notebooks set title=$1 where id=$2 returning title', ['Privado de A actualizado', id])).rows[0].title, 'Privado de A actualizado');
    await assert.rejects(db.query('insert into public.notebooks (owner_id,title) values ($1,$2)', [b, 'Suplantado']), /row-level security/);
    await assert.rejects(db.query('update public.notebooks set owner_id=$1 where id=$2', [b, id]), /permission denied/);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [b]);
    assert.equal((await db.query('select * from public.notebooks')).rows.length, 0);
    assert.equal((await db.query('update public.notebooks set title=$1 where id=$2 returning id', ['Ataque', id])).rows.length, 0);
    assert.equal((await db.query('delete from public.notebooks where id=$1 returning id', [id])).rows.length, 0);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select * from public.notebooks'), /permission denied/);
    await db.exec('reset role; set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [a]);
    assert.equal((await db.query('select title from public.notebooks where id=$1', [id])).rows[0].title, 'Privado de A actualizado');
    assert.equal((await db.query('delete from public.notebooks where id=$1 returning id', [id])).rows.length, 1);
  } finally { await db.close(); }
});
