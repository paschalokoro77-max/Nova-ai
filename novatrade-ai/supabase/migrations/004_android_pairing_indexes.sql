-- NovaTrade AI — Additive Supabase Migration (004_android_pairing_indexes.sql)
-- Adds performance indexes for fast atomic lookup during Android pairing code redemption and token authentication.

create index if not exists idx_android_devices_pairing_hash
  on public.android_devices(pairing_code_hash)
  where pairing_code_hash is not null and status = 'PAIRED_PENDING';

create index if not exists idx_android_devices_token_hash
  on public.android_devices(device_token_hash)
  where device_token_hash is not null and status <> 'REVOKED';
