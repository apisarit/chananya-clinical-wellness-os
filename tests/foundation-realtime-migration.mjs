import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const sql = fs.readFileSync(new URL('../supabase/migrations/20260923033743_foundation_realtime.sql', import.meta.url), 'utf8');
const tables = ['ttm_sources', 'ttm_concepts', 'ttm_concept_relations', 'ttm_diagnostic_knowledge'];
const db = new PGlite();
try {
  await db.exec('create role authenticated; create table public.unrelated(id int primary key); create publication supabase_realtime for table public.unrelated;');
  for (const table of tables) await db.exec(`
    create table public.${table}(id integer primary key, active boolean default true);
    alter table public.${table} enable row level security;
    grant select on public.${table} to authenticated;
    create policy knowledge_read on public.${table} for select to authenticated using (true);
  `);
  await db.exec(sql);
  await db.exec(sql);
  assert.deepEqual((await db.query("select tablename from pg_publication_tables where pubname='supabase_realtime' order by tablename")).rows.map(row => row.tablename), [...tables, 'unrelated'].sort());
  assert.equal((await db.query("select count(*)::int as n from pg_policies where policyname='knowledge_read'")).rows[0].n, 4);
  await db.exec('alter publication supabase_realtime drop table public.ttm_sources; alter table public.ttm_concepts disable row level security;');
  await assert.rejects(db.exec(sql), /RLS-enabled/);
  await db.exec('rollback;');
  assert.equal((await db.query("select count(*)::int as n from pg_publication_tables where pubname='supabase_realtime' and tablename='ttm_sources'")).rows[0].n, 0, 'failed migration must roll back partial membership');
  console.log('Foundation migration passed: idempotent, preserves publication members/policies, rejects missing RLS atomically.');
} finally { await db.close(); }
