-- NovaTrade AI — Additive Supabase Migration (003_android_companion.sql)
-- Adds Android App Bridge persistence (device pairing, multimodal screen analyses, guarded action queue)
-- Preserves all existing tables, RLS policies, and data.
-- Security model:
--   1. Authenticated users can ONLY read their own records via RLS (auth.uid() = user_id).
--   2. All device pairing/registration, token management, permission updates, screen analysis writes,
--      and action status transitions MUST execute through the trusted backend (service_role).
--   3. Supports DEMO, PRACTICE, and REAL account modes when verified against genuine broker
--      session/account records (never guessed from screenshots alone).

create extension if not exists pgcrypto;

-- 1. Paired Android Devices (per-user, hashed pairing codes, scoped device tokens & configurable permissions)
create table if not exists public.android_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_name text not null,
  device_model text,
  os_version text,
  pairing_code_hash text,
  pairing_expires_at timestamptz,
  device_token_hash text unique,
  token_prefix text,
  permissions jsonb not null default '{
    "mediaProjection": false,
    "accessibility": false,
    "allowMt5": true,
    "allowIqOption": true,
    "assistedApprovalRequired": true,
    "allowRealAccountExecution": false,
    "requireVerifiedBrokerAccount": true
  }'::jsonb,
  target_packages jsonb not null default '["net.metaquotes.metatrader5","com.iqoption"]'::jsonb,
  status text not null default 'PAIRED_PENDING'
    check (status in ('PAIRED_PENDING','ACTIVE','PAUSED','REVOKED')),
  last_app_package text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.android_devices enable row level security;

drop policy if exists "users manage own android devices" on public.android_devices;
drop policy if exists "users read own android devices" on public.android_devices;
create policy "users read own android devices"
  on public.android_devices for select
  to authenticated
  using (auth.uid() = user_id);

-- 2. Android Screen Vision Analyses (Gemini multimodal extraction + quant cross-check)
-- Note: detected_account_mode is strictly advisory OCR/visual telemetry from the screenshot.
create table if not exists public.android_screen_analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.android_devices(id) on delete set null,
  app_package text not null default 'unknown',
  app_name text not null default 'UNKNOWN'
    check (app_name in ('MT5','IQ_OPTION','UNKNOWN')),
  detected_symbol text,
  normalized_symbol text,
  detected_timeframe text,
  detected_price numeric(18,6),
  detected_account_mode text not null default 'UNKNOWN'
    check (detected_account_mode in ('DEMO','PRACTICE','REAL','UNKNOWN')),
  detected_balance numeric(14,2),
  detected_currency text,
  chart_trend text not null default 'UNCLEAR',
  vision_summary text not null default '',
  risk_warning text,
  recommended_action text not null default 'WAIT'
    check (recommended_action in ('CALL','PUT','WAIT')),
  confidence_score integer not null default 0 check (confidence_score between 0 and 100),
  signal_id uuid references public.trading_signals(id) on delete set null,
  quant_cross_check jsonb not null default '{}'::jsonb,
  raw_extraction jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.android_screen_analyses enable row level security;

drop policy if exists "users insert own android screen analyses" on public.android_screen_analyses;
drop policy if exists "users read own android screen analyses" on public.android_screen_analyses;
create policy "users read own android screen analyses"
  on public.android_screen_analyses for select
  to authenticated
  using (auth.uid() = user_id);

-- 3. Guarded Android Action Queue (User authorization + genuine broker account verification + risk/emergency-stop controls)
create table if not exists public.android_action_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid references public.android_devices(id) on delete set null,
  screen_analysis_id uuid references public.android_screen_analyses(id) on delete set null,
  app_package text not null default 'unknown',
  app_name text not null default 'UNKNOWN'
    check (app_name in ('MT5','IQ_OPTION','UNKNOWN')),
  operating_mode text not null default 'assisted'
    check (operating_mode in ('signals','assisted','automatic')),
  symbol text not null,
  direction text not null check (direction in ('CALL','PUT')),
  stake_or_volume numeric(14,2) not null check (stake_or_volume > 0),
  expiry_seconds integer not null default 180,
  account_mode_verified text not null default 'UNKNOWN'
    check (account_mode_verified in ('DEMO','PRACTICE','REAL','UNKNOWN')),
  account_mode_verification_source text not null default 'UNVERIFIED'
    check (account_mode_verification_source in ('BROKER_SESSION','MT5_BRIDGE','IQ_CONNECTOR','UNVERIFIED')),
  verified_broker_account_id text,
  status text not null default 'PENDING_USER_APPROVAL'
    check (status in (
      'PENDING_USER_APPROVAL',
      'AUTHORIZED',
      'DISPATCHED_TO_DEVICE',
      'EXECUTED_REPORTED',
      'REJECTED',
      'BLOCKED_RISK',
      'BLOCKED_UNVERIFIED_ACCOUNT',
      'EXPIRED'
    )),
  risk_check_snapshot jsonb not null default '{}'::jsonb,
  reason text,
  expires_at timestamptz,
  approved_at timestamptz,
  executed_at timestamptz,
  device_ack_note text,
  created_at timestamptz not null default now(),
  constraint android_action_requires_verified_broker_mode
    check (
      not (
        status in ('AUTHORIZED','DISPATCHED_TO_DEVICE','EXECUTED_REPORTED')
        and (account_mode_verified = 'UNKNOWN' or account_mode_verification_source = 'UNVERIFIED')
      )
    )
);

-- Ensure any legacy blanket REAL-money constraint from earlier drafts is removed if re-running
alter table if exists public.android_action_queue
  drop constraint if exists android_action_real_money_locked;

alter table public.android_action_queue enable row level security;

drop policy if exists "users manage own android actions" on public.android_action_queue;
drop policy if exists "users read own android actions" on public.android_action_queue;
create policy "users read own android actions"
  on public.android_action_queue for select
  to authenticated
  using (auth.uid() = user_id);

-- Privilege hardening: disallow direct client writes/mutations; backend service_role handles all writes
revoke all on public.android_devices from anon;
revoke all on public.android_screen_analyses from anon;
revoke all on public.android_action_queue from anon;

revoke insert, update, delete on public.android_devices from authenticated;
revoke insert, update, delete on public.android_screen_analyses from authenticated;
revoke insert, update, delete on public.android_action_queue from authenticated;

grant select on public.android_devices to authenticated;
grant select on public.android_screen_analyses to authenticated;
grant select on public.android_action_queue to authenticated;

grant all on public.android_devices to service_role;
grant all on public.android_screen_analyses to service_role;
grant all on public.android_action_queue to service_role;

-- Performance indexes
create index if not exists idx_android_devices_user on public.android_devices(user_id, created_at desc);
create index if not exists idx_android_screen_analyses_user on public.android_screen_analyses(user_id, created_at desc);
create index if not exists idx_android_action_queue_user_status on public.android_action_queue(user_id, status, created_at desc);
create index if not exists idx_android_action_queue_device_status on public.android_action_queue(device_id, status);

