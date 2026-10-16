import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';

test('conversaciones SQL: migraciones reales, RLS de propietario/cuaderno, límites, inmutabilidad y cascada',async () => {
  const db = new PGlite({ extensions: { vector } });
  const a = randomUUID(),b = randomUUID();
  const login = async id => { await db.exec('reset role; set role authenticated'); await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]); };
  try {
    await db.exec(`create role anon nologin; create role authenticated nologin;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as 'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
      grant usage on schema public,auth to authenticated,anon;
      create schema storage; create table storage.buckets(id text primary key,name text,public boolean);`);
    await db.query('insert into auth.users values($1),($2)',[a,b]);
    for (const file of ['202610160001_notebooks.sql','202610160005_conversations.sql']) await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
    const book = async id => { await login(id); return (await db.query("insert into public.notebooks(owner_id,title) values($1,'Historial') returning id",[id])).rows[0].id; };
    const bookA = await book(a),bookB = await book(b);
    const insert = (owner,notebook,question = 'Pregunta de prueba',answer = '{}') => db.query('insert into public.notebook_turns(owner_id,notebook_id,question,answer) values($1,$2,$3,$4) returning id',[owner,notebook,question,answer]);
    await login(a); const turnA = (await insert(a,bookA)).rows[0].id;
    await assert.rejects(insert(a,bookB),/row-level security/);
    await assert.rejects(insert(b,bookA),/row-level security/);
    await assert.rejects(insert(a,bookA,''),/check constraint/);
    await assert.rejects(insert(a,bookA,'a'.repeat(1001)),/check constraint/);
    await assert.rejects(insert(a,bookA,'Pregunta','[]'),/check constraint/);
    await assert.rejects(insert(a,bookA,'Pregunta',JSON.stringify({ text: 'x'.repeat(65536) })),/check constraint/);
    await assert.rejects(db.query("update public.notebook_turns set question='Editada' where id=$1",[turnA]),/permission denied/);
    await assert.rejects(db.query("insert into public.notebook_turns(id,owner_id,notebook_id,question,answer) values($1,$2,$3,'Pregunta','{}')",[randomUUID(),a,bookA]),/permission denied/);
    await login(b); await insert(b,bookB);
    assert.equal((await db.query('select * from public.notebook_turns')).rows.length,1);
    assert.equal((await db.query('select * from public.notebook_turns where notebook_id=$1',[bookA])).rows.length,0);
    await db.query('delete from public.notebook_turns where id=$1',[turnA]);
    await login(a); assert.equal((await db.query('select * from public.notebook_turns')).rows.length,1);
    await db.query('delete from public.notebooks where id=$1',[bookA]);
    assert.equal((await db.query('select * from public.notebook_turns')).rows.length,0);
    await login(b); assert.equal((await db.query('select * from public.notebook_turns')).rows.length,1);
    await db.exec('reset role; set role anon');
    await assert.rejects(db.query('select * from public.notebook_turns'),/permission denied/);
  } finally { await db.close(); }
});
