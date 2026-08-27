import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTenantConfig } from './generate-tenant-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] || process.env.CLINICAL_OS_TENANT_CONFIG_PATH || 'config/tenant.chananya.json';
const config = validateTenantConfig(JSON.parse(fs.readFileSync(path.resolve(root, source), 'utf8')));
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const { tenant, brand } = config;

process.stdout.write(`-- Review and run once in the customer's isolated Supabase project after all migrations.\n`);
process.stdout.write(`begin;\n`);
process.stdout.write(`update public.clinics\n`);
process.stdout.write(`set code = ${quote(tenant.expectedClinicCode)},\n`);
process.stdout.write(`    name_th = ${quote(brand.nameTh)},\n`);
process.stdout.write(`    name_en = ${quote(brand.nameEn)},\n`);
process.stdout.write(`    updated_at = now()\n`);
process.stdout.write(`where id = ${quote(tenant.expectedClinicId)}::uuid;\n`);
process.stdout.write(`do $$ begin\n`);
process.stdout.write(`  if not exists (select 1 from public.clinics where id = ${quote(tenant.expectedClinicId)}::uuid and code = ${quote(tenant.expectedClinicCode)}) then\n`);
process.stdout.write(`    raise exception 'Tenant bootstrap did not update the expected clinic';\n`);
process.stdout.write(`  end if;\n`);
process.stdout.write(`end $$;\n`);
process.stdout.write(`commit;\n`);
