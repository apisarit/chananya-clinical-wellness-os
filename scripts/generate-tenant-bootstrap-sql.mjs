import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTenantConfig } from './generate-tenant-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] || process.env.CLINICAL_OS_TENANT_CONFIG_PATH || 'config/tenant.chananya.json';
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

export function buildTenantBootstrapSql(input) {
  const config = validateTenantConfig(input);
  const { tenant, brand, deploymentId } = config;
  const clinicId = quote(tenant.expectedClinicId);
  const clinicCode = quote(tenant.expectedClinicCode);
  const nameTh = quote(brand.nameTh);
  const nameEn = quote(brand.nameEn);

  return `-- Review and run once in the customer's isolated Supabase project after all migrations.\n` +
    `-- Idempotent tenant bootstrap for ${deploymentId}; the canonical migration seed is never re-keyed.\n` +
    `begin;\n` +
    `select pg_advisory_xact_lock(202608302101::bigint);\n` +
    `do $tenant_collision_guard$\n` +
    `begin\n` +
    `  if exists (\n` +
    `    select 1 from public.clinics\n` +
    `    where id = ${clinicId}::uuid and code <> ${clinicCode}\n` +
    `  ) then raise exception 'TENANT_BOOTSTRAP_CLINIC_ID_CONFLICT'; end if;\n` +
    `  if exists (\n` +
    `    select 1 from public.clinics\n` +
    `    where code = ${clinicCode} and id <> ${clinicId}::uuid\n` +
    `  ) then raise exception 'TENANT_BOOTSTRAP_CLINIC_CODE_CONFLICT'; end if;\n` +
    `end\n` +
    `$tenant_collision_guard$;\n` +
    `insert into public.clinics (id, code, name_th, name_en, active, updated_at)\n` +
    `values (${clinicId}::uuid, ${clinicCode}, ${nameTh}, ${nameEn}, true, now())\n` +
    `on conflict (id) do update set\n` +
    `  code = excluded.code,\n` +
    `  name_th = excluded.name_th,\n` +
    `  name_en = excluded.name_en,\n` +
    `  updated_at = now()\n` +
    `where clinics.code = excluded.code;\n` +
    `do $tenant_bootstrap_guard$\n` +
    `begin\n` +
    `  if exists (\n` +
    `    select 1 from public.clinics\n` +
    `    where id = ${clinicId}::uuid\n` +
    `      and code = ${clinicCode}\n` +
    `      and (not active or subscription_state = 'suspended')\n` +
    `  ) then raise exception 'TENANT_BOOTSTRAP_SUBSCRIPTION_SUSPENDED'; end if;\n` +
    `  if not exists (\n` +
    `    select 1 from public.clinics\n` +
    `    where id = ${clinicId}::uuid\n` +
    `      and code = ${clinicCode}\n` +
    `      and name_th = ${nameTh}\n` +
    `      and name_en is not distinct from ${nameEn}\n` +
    `      and active\n` +
    `  ) then raise exception 'TENANT_BOOTSTRAP_VERIFICATION_FAILED'; end if;\n` +
    `end\n` +
    `$tenant_bootstrap_guard$;\n` +
    `commit;\n` +
    `select jsonb_build_object(\n` +
    `  'status','CHANANYA_TENANT_BOOTSTRAP_READY',\n` +
    `  'deployment_id',${quote(deploymentId)},\n` +
    `  'clinic_id',id,\n` +
    `  'clinic_code',code\n` +
    `) as tenant_bootstrap_evidence\n` +
    `from public.clinics where id=${clinicId}::uuid;\n`;
}

function main() {
  const config = JSON.parse(fs.readFileSync(path.resolve(root, source), 'utf8'));
  process.stdout.write(buildTenantBootstrapSql(config));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
