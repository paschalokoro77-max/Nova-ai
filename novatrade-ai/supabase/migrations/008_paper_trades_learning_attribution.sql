-- NovaTrade AI — Independent Account Bucket & Adaptive Strategy Attribution for Paper Trades
alter table public.paper_trades
  add column if not exists account_bucket text,
  add column if not exists strategy_name text;
