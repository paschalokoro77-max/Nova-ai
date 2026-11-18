-- NovaTrade AI — Additive Supabase Migration (002_virtual_balance_and_daily_limit.sql)
-- Adds virtual starting balance and max daily trades limits without modifying or deleting existing rows.

alter table public.user_settings
  add column if not exists starting_virtual_balance numeric(14,2) not null default 10000 check (starting_virtual_balance > 0),
  add column if not exists max_daily_trades integer not null default 25 check (max_daily_trades between 1 and 500);

alter table public.trading_signals
  add column if not exists risk_assessment jsonb not null default '{}'::jsonb;
