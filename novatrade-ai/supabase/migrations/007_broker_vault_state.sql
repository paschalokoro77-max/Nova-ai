-- Safe, idempotent migration for encrypted broker vault persistence (accounts, orders, idempotency keys).
-- Stores ONLY AES-256-GCM encrypted credential payloads (never plaintext passwords or API secrets).

create table if not exists public.broker_vault_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  active_account_id text,
  auto_execute_broker_demo boolean not null default false,
  accounts_json jsonb not null default '[]'::jsonb,
  orders_json jsonb not null default '[]'::jsonb,
  idempotency_keys_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.broker_vault_state enable row level security;

drop policy if exists "users manage own broker vault state" on public.broker_vault_state;
create policy "users manage own broker vault state"
  on public.broker_vault_state for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
