-- Disposable-fixture prototype only. Not a migration or production activation.
-- Receipt-aware unlock and legacy RPC disposition must be integrated before use.
create schema cnyos_amendment_test;
revoke all on schema cnyos_amendment_test from public;
alter table public.clinical_record_signoffs
  add column signature_generation bigint not null default 1
  check (signature_generation > 0);

create function cnyos_amendment_test.assign_generation()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if TG_OP = 'INSERT' then
    NEW.signature_generation := 1;
  elsif NEW.lock_record then
    -- A sign operation upserts the same row, even within one transaction.
    -- Overflow raises an error; never wrap or silently reuse a generation.
    NEW.signature_generation := OLD.signature_generation + 1;
  else
    NEW.signature_generation := OLD.signature_generation;
  end if;
  return NEW;
end;
$$;
revoke all on function cnyos_amendment_test.assign_generation() from public;
create trigger assign_signature_generation
before insert or update on public.clinical_record_signoffs
for each row execute function cnyos_amendment_test.assign_generation();
