-- NovaTrade AI — Additive Supabase Migration (005_android_pairing_rpc.sql)
-- Implements truly atomic pairing-code redemption via PostgreSQL transaction RPC.

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
as $$
declare
  v_device record;
  v_new_permissions jsonb;
begin
  -- 1. Find and lock matching pending unexpired pairing record atomically
  select *
    into v_device
    from public.android_devices
   where pairing_code_hash = p_pairing_code_hash
     and status = 'PAIRED_PENDING'
     and pairing_expires_at > now()
   for update;

  if not found then
    return null;
  end if;

  -- 2. Merge permissions while strictly preserving realMoneyBlocked = true
  v_device.permissions := jsonb_set(
    jsonb_set(
      v_device.permissions,
      '{mediaProjection}',
      to_jsonb(coalesce(p_media_projection, false))
    ),
    '{accessibility}',
    to_jsonb(coalesce(p_accessibility, false))
  );
  v_device.permissions := jsonb_set(v_device.permissions, '{realMoneyBlocked}', 'true'::jsonb);

  -- 3. Update device record atomically and clear pairing code (single-use)
  update public.android_devices
     set device_name = coalesce(nullif(trim(p_device_name), ''), device_name),
         device_model = nullif(trim(p_device_model), ''),
         os_version = nullif(trim(p_os_version), ''),
         pairing_code_hash = null,
         pairing_expires_at = null,
         device_token_hash = p_token_hash,
         token_prefix = p_token_prefix,
         permissions = v_device.permissions,
         status = 'ACTIVE',
         last_seen_at = now(),
         updated_at = now()
   where id = v_device.id
     and status = 'PAIRED_PENDING';

  -- 4. Return updated device record as jsonb
  select to_jsonb(d)
    into v_device
    from public.android_devices d
   where d.id = v_device.id;

  return to_jsonb(v_device);
end;
$$;

grant execute on function public.redeem_android_pairing_code to service_role;
revoke execute on function public.redeem_android_pairing_code from anon;
revoke execute on function public.redeem_android_pairing_code from authenticated;
