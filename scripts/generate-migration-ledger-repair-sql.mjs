import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTenantConfig } from './generate-tenant-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagingMarker = /(?:^|[-_.])(staging|stage|nonprod|test)(?:$|[-_.])/i;
const migrationName = /^(\d{12,14})_([a-z0-9_]+)\.sql$/i;

const requiredRelations = [
  'public.profiles',
  'public.audit_logs',
  'public.patients',
  'public.products',
  'public.encounters',
  'public.payments',
  'public.production_orders',
  'public.pharmacy_counter_sales',
  'public.approval_tasks',
  'public.clinical_examination_findings',
  'public.clinic_appointments',
  'public.sen_line_master',
  'public.ttm_diagnostic_knowledge',
  'public.ttm_opd_histories',
  'public.clinical_record_audit_events',
  'public.ttm_sources',
  'public.clinics',
  'public.clinic_memberships',
  'public.patient_identity_links',
  'public.backup_export_runs',
  'public.line_oa_contacts',
  'public.line_oa_notification_preferences',
  'public.line_oa_webhook_events',
  'public.line_oa_notification_outbox',
  'public.line_oa_delivery_events',
  'public.line_oa_gateway_contact_states',
  'public.line_oa_gateway_webhook_events',
  'public.user_access_summary',
  'public.admin_task_summary',
  'public.v_clinical_herbal_traceability',
  'public.available_practitioner_schedules',
  'public.v_ttm_foundation_graph'
];

const requiredFunctions = [
  'has_role',
  'dispense_pharmacy_counter_sale',
  'current_access_context',
  'save_ttm_diagnosis_atomic',
  'create_clinical_treatment_session',
  'sign_clinical_record_complete',
  'hybrid_patient_identity_healthcheck',
  'clinical_financial_handoffs_healthcheck',
  'department_persistence_healthcheck',
  'production_execution_healthcheck',
  'quality_release_healthcheck',
  'clinical_outcomes_summary',
  'prescription_dispensing_healthcheck',
  'backup_restore_contract_healthcheck',
  'export_clinic_backup_domain',
  'line_oa_operational_healthcheck',
  'register_line_oa_webhook_event',
  'finalize_line_oa_webhook_event',
  'line_oa_webhook_evidence'
];

const requiredSecurityDefiners = [
  'save_ttm_diagnosis_atomic',
  'export_clinic_backup_domain',
  'register_line_oa_webhook_event',
  'finalize_line_oa_webhook_event',
  'line_oa_webhook_evidence'
];

const requiredColumns = [
  'body_pain_points.side',
  'body_pain_points.body_region',
  'body_pain_points.sen_line_code',
  'body_pain_points.point_label',
  'body_pain_points.pain_pattern_code',
  'body_pain_points.updated_at',
  'profiles.system_role',
  'patients.clinic_id',
  'encounters.clinic_id',
  'products.clinic_id',
  'inventory_lots.clinic_id',
  'line_oa_webhook_events.locked_until',
  'line_oa_notification_outbox.next_attempt_at',
  'line_oa_gateway_webhook_events.last_attempt_at'
];

const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const sqlArray = values => `array[${values.map(quote).join(',')}]::text[]`;

export function loadMigrationEntries(cwd = root) {
  const directory = path.join(cwd, 'supabase', 'migrations');
  const entries = fs.readdirSync(directory)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => {
      const parsed = file.match(migrationName);
      if (!parsed) throw new Error(`Migration filename is not canonical: ${file}`);
      const source = fs.readFileSync(path.join(directory, file), 'utf8');
      return {
        version: parsed[1],
        name: parsed[2],
        file,
        sha256: createHash('sha256').update(source).digest('hex')
      };
    });
  if (!entries.length) throw new Error('No ordered Supabase migrations were found');
  if (new Set(entries.map(entry => entry.version)).size !== entries.length) {
    throw new Error('Migration versions must be unique');
  }
  return entries;
}

export function buildMigrationLedgerRepairSql({ config, entries = loadMigrationEntries(), sourceRevision = '' }) {
  const target = validateTenantConfig(config);
  if (!stagingMarker.test(target.deploymentId)) {
    throw new Error('Migration ledger recovery is restricted to a staging/non-production deployment');
  }
  if (!/(?:STG|STAGING|TEST|NONPROD)/i.test(target.tenant.expectedClinicCode)) {
    throw new Error('Migration ledger recovery requires an explicit staging clinic code');
  }
  if (!entries.length) throw new Error('Migration ledger recovery requires at least one migration');

  const expectedRows = entries
    .map(entry => `(${quote(entry.version)},${quote(entry.name)})`)
    .join(',\n      ');
  const inserts = entries
    .map(entry => {
      const evidence = `-- recovered from supabase/migrations/${entry.file}; sha256=${entry.sha256}`;
      return `(${quote(entry.version)},${quote(entry.name)},array[${quote(evidence)}]::text[])`;
    })
    .join(',\n  ');
  const revision = String(sourceRevision || '').trim().toLowerCase();
  if (revision && !/^[0-9a-f]{7,40}$/.test(revision)) {
    throw new Error('Source revision must be a 7-40 character hexadecimal Git revision');
  }

  return `-- Generated one-time staging migration ledger recovery.\n` +
    `-- Target: ${target.deploymentId} / ${target.tenant.expectedClinicCode}.\n` +
    `-- Source revision: ${revision || 'not-supplied'}; migration count: ${entries.length}.\n` +
    `-- Run only after every ordered migration has been applied to the isolated, empty staging database.\n` +
    `begin;\n` +
    `select pg_advisory_xact_lock(202608302100::bigint);\n` +
    `do $ledger_guard$\n` +
    `declare\n` +
    `  v_missing text;\n` +
    `  v_transactional_rows bigint;\n` +
    `begin\n` +
    `  select string_agg(object_name, ', ' order by object_name) into v_missing\n` +
    `  from unnest(${sqlArray(requiredRelations)}) expected(object_name)\n` +
    `  where to_regclass(object_name) is null;\n` +
    `  if v_missing is not null then raise exception 'STAGING_SCHEMA_RELATIONS_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(function_name, ', ' order by function_name) into v_missing\n` +
    `  from unnest(${sqlArray(requiredFunctions)}) expected(function_name)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace\n` +
    `    where n.nspname='public' and p.proname=function_name\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SCHEMA_FUNCTIONS_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(column_ref, ', ' order by column_ref) into v_missing\n` +
    `  from unnest(${sqlArray(requiredColumns)}) expected(column_ref)\n` +
    `  where not exists (\n` +
    `    select 1 from information_schema.columns c\n` +
    `    where c.table_schema='public'\n` +
    `      and c.table_name=split_part(column_ref,'.',1)\n` +
    `      and c.column_name=split_part(column_ref,'.',2)\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SCHEMA_COLUMNS_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  select string_agg(function_name, ', ' order by function_name) into v_missing\n` +
    `  from unnest(${sqlArray(requiredSecurityDefiners)}) expected(function_name)\n` +
    `  where not exists (\n` +
    `    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace\n` +
    `    where n.nspname='public' and p.proname=function_name and p.prosecdef\n` +
    `  );\n` +
    `  if v_missing is not null then raise exception 'STAGING_SECURITY_DEFINERS_MISSING: %', v_missing; end if;\n` +
    `\n` +
    `  if not exists (\n` +
    `    select 1 from public.clinics\n` +
    `    where id=${quote(target.tenant.expectedClinicId)}::uuid\n` +
    `      and code=${quote(target.tenant.expectedClinicCode)} and active\n` +
    `  ) then raise exception 'STAGING_CLINIC_MISMATCH'; end if;\n` +
    `  if not exists (\n` +
    `    select 1 from public.clinic_memberships m\n` +
    `    join public.profiles p on p.id=m.profile_id\n` +
    `    where m.clinic_id=${quote(target.tenant.expectedClinicId)}::uuid\n` +
    `      and m.active and p.system_role='super_admin'\n` +
    `  ) then raise exception 'STAGING_ACTIVE_MEMBERSHIP_REQUIRED'; end if;\n` +
    `  if not exists (select 1 from public.profiles where system_role='super_admin') then\n` +
    `    raise exception 'STAGING_SUPER_ADMIN_REQUIRED';\n` +
    `  end if;\n` +
    `  perform set_config(\n` +
    `    'request.jwt.claim.sub',\n` +
    `    (select m.profile_id::text from public.clinic_memberships m\n` +
    `     join public.profiles p on p.id=m.profile_id\n` +
    `     where m.clinic_id=${quote(target.tenant.expectedClinicId)}::uuid\n` +
    `       and m.active and p.system_role='super_admin'\n` +
    `     order by m.is_primary desc,m.joined_at limit 1),\n` +
    `    true\n` +
    `  );\n` +
    `  perform set_config('request.jwt.claim.role','authenticated',true);\n` +
    `\n` +
    `  select (select count(*) from public.patients)\n` +
    `       + (select count(*) from public.encounters)\n` +
    `       + (select count(*) from public.invoices)\n` +
    `       + (select count(*) from public.payments)\n` +
    `  into v_transactional_rows;\n` +
    `  if v_transactional_rows <> 0 then\n` +
    `    raise exception 'STAGING_LEDGER_RECOVERY_REQUIRES_EMPTY_TRANSACTIONAL_DATA: %', v_transactional_rows;\n` +
    `  end if;\n` +
    `\n` +
    `  if not exists (select 1 from pg_policies where schemaname='public' and tablename='products' and policyname='products_read_staff') then\n` +
    `    raise exception 'STAGING_PRODUCTS_READ_POLICY_MISSING';\n` +
    `  end if;\n` +
    `  if not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='line_oa_webhook_events' and c.relrowsecurity) then\n` +
    `    raise exception 'STAGING_LINE_OA_OPERATIONAL_RLS_MISSING';\n` +
    `  end if;\n` +
    `  if not exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname='line_oa_gateway_webhook_events' and c.relrowsecurity) then\n` +
    `    raise exception 'STAGING_LINE_OA_GATEWAY_RLS_MISSING';\n` +
    `  end if;\n` +
    `\n` +
    `  if not exists (select 1 from public.hybrid_patient_identity_healthcheck() where ready) then raise exception 'HYBRID_IDENTITY_HEALTHCHECK_FAILED'; end if;\n` +
    `  if not exists (select 1 from public.clinical_financial_handoffs_healthcheck() where ready) then raise exception 'CLINICAL_HANDOFF_HEALTHCHECK_FAILED'; end if;\n` +
    `  if not exists (select 1 from public.department_persistence_healthcheck() where ready) then raise exception 'DEPARTMENT_PERSISTENCE_HEALTHCHECK_FAILED'; end if;\n` +
    `  if not exists (select 1 from public.production_execution_healthcheck() where ready) then raise exception 'PRODUCTION_EXECUTION_HEALTHCHECK_FAILED'; end if;\n` +
    `  if not exists (select 1 from public.quality_release_healthcheck() where ready) then raise exception 'QUALITY_RELEASE_HEALTHCHECK_FAILED'; end if;\n` +
    `  if not exists (select 1 from public.prescription_dispensing_healthcheck() where ready) then raise exception 'PRESCRIPTION_DISPENSING_HEALTHCHECK_FAILED'; end if;\n` +
    `  if not exists (select 1 from public.backup_restore_contract_healthcheck() where ready) then raise exception 'BACKUP_RESTORE_HEALTHCHECK_FAILED'; end if;\n` +
    `  if not exists (select 1 from public.line_oa_operational_healthcheck() where ready) then raise exception 'LINE_OA_OPERATIONAL_HEALTHCHECK_FAILED'; end if;\n` +
    `end\n` +
    `$ledger_guard$;\n` +
    `\n` +
    `create schema if not exists supabase_migrations;\n` +
    `create table if not exists supabase_migrations.schema_migrations (\n` +
    `  version text not null primary key\n` +
    `);\n` +
    `alter table supabase_migrations.schema_migrations add column if not exists statements text[];\n` +
    `alter table supabase_migrations.schema_migrations add column if not exists name text;\n` +
    `\n` +
    `do $ledger_conflict_guard$\n` +
    `begin\n` +
    `  if exists (\n` +
    `    select 1\n` +
    `    from supabase_migrations.schema_migrations actual\n` +
    `    left join (values\n      ${expectedRows}\n` +
    `    ) expected(version,name) on expected.version=actual.version\n` +
    `    where expected.version is null or actual.name is distinct from expected.name\n` +
    `  ) then raise exception 'MIGRATION_LEDGER_CONFLICT'; end if;\n` +
    `end\n` +
    `$ledger_conflict_guard$;\n` +
    `\n` +
    `insert into supabase_migrations.schema_migrations as ledger(version,name,statements) values\n  ${inserts}\n` +
    `on conflict (version) do update set\n` +
    `  name=coalesce(ledger.name,excluded.name),\n` +
    `  statements=coalesce(ledger.statements,excluded.statements);\n` +
    `\n` +
    `do $ledger_verify$\n` +
    `begin\n` +
    `  if (select count(*) from supabase_migrations.schema_migrations) <> ${entries.length} then\n` +
    `    raise exception 'MIGRATION_LEDGER_ROW_COUNT_MISMATCH';\n` +
    `  end if;\n` +
    `  if exists (select 1 from supabase_migrations.schema_migrations where name is null or statements is null or cardinality(statements)=0) then\n` +
    `    raise exception 'MIGRATION_LEDGER_INCOMPLETE_ROW';\n` +
    `  end if;\n` +
    `end\n` +
    `$ledger_verify$;\n` +
    `\n` +
    `comment on table supabase_migrations.schema_migrations is\n` +
    `  'Canonical Supabase CLI migration history. Recovered only after staging schema fingerprint and empty-data guards passed.';\n` +
    `revoke all on schema supabase_migrations from public, anon, authenticated, service_role;\n` +
    `revoke all on table supabase_migrations.schema_migrations from public, anon, authenticated, service_role;\n` +
    `commit;\n` +
    `\n` +
    `select jsonb_build_object(\n` +
    `  'status','CHANANYA_STAGING_MIGRATION_LEDGER_READY',\n` +
    `  'migration_count',count(*),\n` +
    `  'first_version',min(version),\n` +
    `  'last_version',max(version),\n` +
    `  'source_revision',${quote(revision || 'not-supplied')}\n` +
    `) as migration_ledger_evidence\n` +
    `from supabase_migrations.schema_migrations;\n`;
}

function main() {
  const source = process.argv[2] || process.env.CLINICAL_OS_TENANT_CONFIG_PATH;
  if (!source) {
    throw new Error('Pass an explicit staging tenant config path');
  }
  const configPath = path.resolve(root, source);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  process.stdout.write(buildMigrationLedgerRepairSql({
    config,
    entries: loadMigrationEntries(root),
    sourceRevision: process.env.CLINICAL_OS_SOURCE_COMMIT || ''
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
