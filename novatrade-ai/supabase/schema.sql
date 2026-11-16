-- NovaTrade AI starter schema. Run in Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  preferred_mode text not null default 'signals' check (preferred_mode in ('signals','assisted','automatic')),
  paper_trade_amount numeric(14,2) not null default 100 check (paper_trade_amount > 0),
  daily_loss_limit numeric(14,2) not null default 500 check (daily_loss_limit > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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

create table if not exists public.paper_trades (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  analysis_id uuid references public.analysis_runs(id) on delete set null,
  symbol text not null,
  direction text not null check (direction in ('CALL','PUT')),
  amount numeric(14,2) not null check (amount > 0),
  status text not null default 'SIMULATED_NOT_EXECUTED' check (status in ('SIMULATED_NOT_EXECUTED','CLOSED_WIN','CLOSED_LOSS','CANCELLED')),
  result_amount numeric(14,2),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

alter table public.user_settings enable row level security;
alter table public.analysis_runs enable row level security;
alter table public.paper_trades enable row level security;

create policy "users manage own settings" on public.user_settings for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users read own analyses" on public.analysis_runs for select using (auth.uid() = user_id);
create policy "users create own analyses" on public.analysis_runs for insert with check (auth.uid() = user_id);
create policy "users manage own paper trades" on public.paper_trades for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
