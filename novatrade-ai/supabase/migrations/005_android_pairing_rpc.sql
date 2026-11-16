-- NovaTrade AI — Additive Supabase Migration (005_android_pairing_rpc.sql)
-- Implements truly atomic, single-use pairing-code redemption via PostgreSQL transaction RPC.

create or replace function public.redeem_android_pairing_code(
  p_pairing_code_hash text,
  p_device_name text,
  p_device_model text,
  p_os_version text,
  p_media_projection boolean,
  p_accessibility boolean,
  p_token_hash text,
  p_token_prefix text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_device public.android_devices%rowtype;
  v_new_permissions jsonb;
begin
  -- Reject blank/null pairing hashes or token hashes explicitly
  if nullif(btrim(coalesce(p_pairing_code_hash, '')), '') is null
     or nullif(btrim(coalesce(p_token_hash, '')), '') is null then
    return null;
  end if;

  -- 1. Find and row-lock matching pending, unexpired pairing record atomically
  select *
    into v_device
    from public.android_devices
   where pairing_code_hash = p_pairing_code_hash
     and status = 'PAIRED_PENDING'
     and pairing_expires_at is not null
     and pairing_expires_at > now()
   order by created_at desc
   limit 1
   for update;

  if not found then
    return null;
  end if;

  -- 2. Merge permissions while strictly preserving realMoneyBlocked = true
  v_new_permissions := coalesce(v_device.permissions, '{}'::jsonb);
  v_new_permissions := jsonb_set(v_new_permissions, '{mediaProjection}', to_jsonb(coalesce(p_media_projection, false)), true);
  v_new_permissions := jsonb_set(v_new_permissions, '{accessibility}', to_jsonb(coalesce(p_accessibility, false)), true);
  v_new_permissions := jsonb_set(v_new_permissions, '{realMoneyBlocked}', 'true'::jsonb, true);

  -- 3. Atomically claim and activate device, clearing single-use pairing code
  update public.android_devices
     set device_name = coalesce(nullif(btrim(p_device_name), ''), device_name),
         device_model = coalesce(nullif(btrim(p_device_model), ''), device_model),
         os_version = coalesce(nullif(btrim(p_os_version), ''), os_version),
         pairing_code_hash = null,
         pairing_expires_at = null,
         device_token_hash = p_token_hash,
         token_prefix = nullif(btrim(p_token_prefix), ''),
         permissions = v_new_permissions,
         status = 'ACTIVE',
         last_seen_at = now(),
         updated_at = now()
   where id = v_device.id
     and status = 'PAIRED_PENDING'
     and pairing_code_hash = p_pairing_code_hash
     and pairing_expires_at is not null
     and pairing_expires_at > now()
  returning * into v_device;

  if not found then
    return null;
  end if;

  return to_jsonb(v_device);
end;
$$;

revoke all on function public.redeem_android_pairing_code(text, text, text, text, boolean, boolean, text, text) from public;
revoke all on function public.redeem_android_pairing_code(text, text, text, text, boolean, boolean, text, text) from anon;
revoke all on function public.redeem_android_pairing_code(text, text, text, text, boolean, boolean, text, text) from authenticated;
grant execute on function public.redeem_android_pairing_code(text, text, text, text, boolean, boolean, text, text) to service_role;
