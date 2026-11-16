-- NovaTrade AI — Additive Supabase Migration (001_complete_platform.sql)
-- Safe to run against an existing Supabase database initialized with schema.sql.
-- Preserves all existing tables and data; uses IF NOT EXISTS and additive ALTERs only.

create extension if not exists pgcrypto;

-- 1. User Profiles
create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text not null default '',
  role text not null default 'trader' check (role in ('trader', 'analyst', 'admin')),
  avatar_url text,
  preferred_currency text not null default 'USD',
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_profiles enable row level security;

drop policy if exists "users read own profile" on public.user_profiles;
create policy "users read own profile"
  on public.user_profiles for select
  using (auth.uid() = id);

drop policy if exists "users insert own profile" on public.user_profiles;
create policy "users insert own profile"
  on public.user_profiles for insert
  with check (auth.uid() = id);

drop policy if exists "users update own profile" on public.user_profiles;
create policy "users update own profile"
  on public.user_profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Automatically provision user_profiles + user_settings on signup
create or replace function public.handle_novatrade_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(coalesce(new.email, 'trader'), '@', 1))
  )
  on conflict (id) do nothing;

  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created_novatrade on auth.users;
create trigger on_auth_user_created_novatrade
  after insert on auth.users
  for each row execute function public.handle_novatrade_new_user();

-- 2. Upgrade user_settings (trading, risk, and AI settings) additively
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  preferred_mode text not null default 'signals' check (preferred_mode in ('signals','assisted','automatic')),
  paper_trade_amount numeric(14,2) not null default 100 check (paper_trade_amount > 0),
  daily_loss_limit numeric(14,2) not null default 500 check (daily_loss_limit > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_settings
  add column if not exists daily_profit_target numeric(14,2) not null default 500 check (daily_profit_target > 0),
  add column if not exists max_consecutive_losses integer not null default 3 check (max_consecutive_losses between 1 and 20),
  add column if not exists max_simultaneous_trades integer not null default 3 check (max_simultaneous_trades between 1 and 20),
  add column if not exists trading_schedule_enabled boolean not null default false,
  add column if not exists trading_start_hour_utc integer not null default 7 check (trading_start_hour_utc between 0 and 23),
  add column if not exists trading_end_hour_utc integer not null default 20 check (trading_end_hour_utc between 0 and 23),
  add column if not exists emergency_stop boolean not null default false,
  add column if not exists auto_paper_armed boolean not null default false,
  add column if not exists strategy_profile text not null default 'balanced' check (strategy_profile in ('conservative','balanced','momentum')),
  add column if not exists ai_min_score integer not null default 65 check (ai_min_score between 40 and 95),
  add column if not exists require_mtf_alignment boolean not null default true,
  add column if not exists enabled_assets jsonb not null default '["EURUSD","GBPUSD","USDJPY","BTCUSD","ETHUSD"]'::jsonb,
  add column if not exists default_timeframe text not null default '1m' check (default_timeframe in ('1m','5m','15m','1h')),
  add column if not exists expiry_seconds integer not null default 180 check (expiry_seconds between 60 and 3600),
  add column if not exists scan_interval_seconds integer not null default 60 check (scan_interval_seconds between 15 and 900),
  add column if not exists use_gemini_commentary boolean not null default true;

alter table public.user_settings enable row level security;
drop policy if exists "users manage own settings" on public.user_settings;
create policy "users manage own settings"
  on public.user_settings for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 3. Upgrade analysis_runs additively & add trading_signals
create table if not exists public.analysis_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null,
  timeframe text not null,
  direction text not null check (direction in ('CALL','PUT','WAIT')),
  rule_score integer not null check (rule_score between 0 and 100),
  source text not null,
  reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.analysis_runs
  add column if not exists entry_price numeric(18,6),
  add column if not exists indicators jsonb not null default '{}'::jsonb,
  add column if not exists mtf_alignment text,
  add column if not exists backtest_win_rate numeric(5,2),
  add column if not exists backtest_sample_size integer,
  add column if not exists ai_explanation text;

alter table public.analysis_runs enable row level security;
drop policy if exists "users read own analyses" on public.analysis_runs;
create policy "users read own analyses"
  on public.analysis_runs for select
  using (auth.uid() = user_id);

drop policy if exists "users create own analyses" on public.analysis_runs;
create policy "users create own analyses"
  on public.analysis_runs for insert
  with check (auth.uid() = user_id);

create table if not exists public.trading_signals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  analysis_run_id uuid references public.analysis_runs(id) on delete set null,
  symbol text not null,
  timeframe text not null,
  direction text not null check (direction in ('CALL','PUT','WAIT')),
  score integer not null check (score between 0 and 100),
  entry_price numeric(18,6),
  suggested_expiry_seconds integer not null default 180,
  confidence_win_rate numeric(5,2),
  confidence_sample_size integer not null default 0,
  mtf_alignment text,
  indicators jsonb not null default '{}'::jsonb,
  reasons jsonb not null default '[]'::jsonb,
  ai_explanation text,
  data_source text not null,
  created_at timestamptz not null default now()
);

alter table public.trading_signals enable row level security;
drop policy if exists "users read own trading signals" on public.trading_signals;
create policy "users read own trading signals"
  on public.trading_signals for select
  using (auth.uid() = user_id);

drop policy if exists "users insert own trading signals" on public.trading_signals;
create policy "users insert own trading signals"
  on public.trading_signals for insert
  with check (auth.uid() = user_id);

-- 4. Upgrade paper_trades additively (fix status check mismatch safely)
create table if not exists public.paper_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  analysis_id uuid references public.analysis_runs(id) on delete set null,
  symbol text not null,
  direction text not null check (direction in ('CALL','PUT')),
  amount numeric(14,2) not null check (amount > 0),
  status text not null default 'SIMULATED_NOT_EXECUTED',
  result_amount numeric(14,2),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'paper_trades_status_check'
      and conrelid = 'public.paper_trades'::regclass
  ) then
    alter table public.paper_trades drop constraint paper_trades_status_check;
  end if;
end $$;

alter table public.paper_trades
  add constraint paper_trades_status_check check (
    status in (
      'SIMULATED_NOT_EXECUTED',
      'SIMULATED_PENDING_OUTCOME',
      'SIMULATED_WIN',
      'SIMULATED_LOSS',
      'CLOSED_WIN',
      'CLOSED_LOSS',
      'CANCELLED'
    )
  );

alter table public.paper_trades
  add column if not exists timeframe text not null default '1m',
  add column if not exists mode text not null default 'signals' check (mode in ('signals','assisted','automatic','manual')),
  add column if not exists entry_price numeric(18,6),
  add column if not exists exit_price numeric(18,6),
  add column if not exists expiry_seconds integer not null default 180,
  add column if not exists expires_at timestamptz,
  add column if not exists payout_rate numeric(5,4) not null default 0.80,
  add column if not exists pnl numeric(14,2),
  add column if not exists signal_score integer,
  add column if not exists settled_by text;

alter table public.paper_trades enable row level security;
drop policy if exists "users manage own paper trades" on public.paper_trades;
create policy "users manage own paper trades"
  on public.paper_trades for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 5. Trade Results ledger
create table if not exists public.trade_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  paper_trade_id uuid references public.paper_trades(id) on delete cascade,
  symbol text not null,
  direction text not null check (direction in ('CALL','PUT')),
  mode text not null default 'automatic',
  stake numeric(14,2) not null,
  pnl numeric(14,2) not null,
  outcome text not null check (outcome in ('WIN','LOSS','TIE','CANCELLED')),
  entry_price numeric(18,6),
  exit_price numeric(18,6),
  settled_at timestamptz not null default now()
);

alter table public.trade_results enable row level security;
drop policy if exists "users manage own trade results" on public.trade_results;
create policy "users manage own trade results"
  on public.trade_results for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 6. Broker Connections
create table if not exists public.broker_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  broker_name text not null,
  environment text not null default 'PRACTICE' check (environment in ('PRACTICE','REAL')),
  status text not null default 'DISCONNECTED' check (status in ('CONNECTED','DISCONNECTED','UNCONFIGURED','ERROR')),
  account_type text,
  last_balance numeric(14,2),
  currency text default 'USD',
  capabilities jsonb not null default '{}'::jsonb,
  execution_enabled boolean not null default false,
  last_error text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, broker_name)
);

alter table public.broker_connections enable row level security;
drop policy if exists "users manage own broker connections" on public.broker_connections;
create policy "users manage own broker connections"
  on public.broker_connections for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 7. Account Activity & Risk Audit Log
create table if not exists public.account_activity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  category text not null check (category in ('AUTH','ANALYSIS','TRADE','RISK','BROKER','SETTINGS','SCHEDULER')),
  summary text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.account_activity enable row level security;
drop policy if exists "users read own activity" on public.account_activity;
create policy "users read own activity"
  on public.account_activity for select
  using (auth.uid() = user_id);

drop policy if exists "users create own activity" on public.account_activity;
create policy "users create own activity"
  on public.account_activity for insert
  with check (auth.uid() = user_id);

-- Indexes for query performance
create index if not exists idx_trading_signals_user_created on public.trading_signals(user_id, created_at desc);
create index if not exists idx_paper_trades_user_created on public.paper_trades(user_id, created_at desc);
create index if not exists idx_paper_trades_status on public.paper_trades(user_id, status);
create index if not exists idx_trade_results_user_settled on public.trade_results(user_id, settled_at desc);
create index if not exists idx_account_activity_user_created on public.account_activity(user_id, created_at desc);
