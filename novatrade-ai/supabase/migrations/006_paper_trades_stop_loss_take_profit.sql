-- Add stop_loss and take_profit columns additively to public.paper_trades
alter table public.paper_trades
  add column if not exists stop_loss numeric(18,6),
  add column if not exists take_profit numeric(18,6);
