-- NovaTrade AI — Additive Supabase Migration (009_engine_runtime_recovery.sql)
-- Persists PerformanceLearner strategy protection states (including post-resume watermarks),
-- pending shadow signals, and assisted proposals across server restarts.

alter table public.user_settings
  add column if not exists runtime_recovery jsonb not null default '{}'::jsonb;
