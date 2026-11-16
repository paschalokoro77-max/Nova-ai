-- NovaTrade AI — Additive Supabase Migration (004_android_pairing_indexes.sql)
-- Adds performance index on pairing_code_hash for fast atomic lookup during Android pairing code redemption.

create index if not exists idx_android_devices_pairing_hash 
  on public.android_devices(pairing_code_hash) 
  where pairing_code_hash is not null;
