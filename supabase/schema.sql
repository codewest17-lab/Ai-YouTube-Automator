-- ===========================================================================
-- Ajet YouTube Uploader — Supabase schema
-- Run this once in the Supabase SQL editor (or via `supabase db push`).
-- ===========================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- videos: one row per detected video, tracks it through the pipeline
-- ---------------------------------------------------------------------------
create table if not exists public.videos (
  id                    uuid primary key default gen_random_uuid(),
  filename              text not null,
  storage_path          text not null,
  thumbnail_path        text,
  thumbnail_public_url  text,
  status                text not null default 'pending'
                          check (status in ('pending','analyzing','analyzed','uploading','uploaded','failed','quota_exceeded')),
  generated_title       text,
  generated_description text,
  hashtags              text[],
  tags                  text[],
  category              text,
  visibility            text not null default 'private'
                          check (visibility in ('public','private','unlisted')),
  youtube_video_id      text,
  youtube_url           text,
  error_message         text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists videos_status_idx on public.videos (status);
create index if not exists videos_created_at_idx on public.videos (created_at desc);

-- ---------------------------------------------------------------------------
-- settings: single-row app configuration
-- ---------------------------------------------------------------------------
create table if not exists public.settings (
  id                     int primary key default 1 check (id = 1),
  upload_folder          text not null default 'Ajet YouTube',
  default_visibility      text not null default 'private'
                          check (default_visibility in ('public','private','unlisted')),
  youtube_connected       boolean not null default false,
  youtube_channel_id      text,
  youtube_channel_title   text,
  updated_at              timestamptz not null default now()
);

insert into public.settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- oauth_tokens: server-only. RLS is enabled with NO policies, so the anon
-- key (used by the app) can never read or write this table. Only Edge
-- Functions using the service_role key can touch it.
-- ---------------------------------------------------------------------------
create table if not exists public.oauth_tokens (
  id            int primary key default 1 check (id = 1),
  access_token  text,
  refresh_token text,
  token_expiry  timestamptz,
  scope         text,
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- upload_history: append-only event log per video
-- ---------------------------------------------------------------------------
create table if not exists public.upload_history (
  id         uuid primary key default gen_random_uuid(),
  video_id   uuid references public.videos (id) on delete cascade,
  event      text not null check (event in ('success','failure','info')),
  message    text not null,
  created_at timestamptz not null default now()
);

create index if not exists upload_history_created_at_idx on public.upload_history (created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists videos_touch_updated_at on public.videos;
create trigger videos_touch_updated_at
  before update on public.videos
  for each row execute function public.touch_updated_at();

drop trigger if exists settings_touch_updated_at on public.settings;
create trigger settings_touch_updated_at
  before update on public.settings
  for each row execute function public.touch_updated_at();

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
alter table public.videos         enable row level security;
alter table public.settings       enable row level security;
alter table public.upload_history enable row level security;
alter table public.oauth_tokens   enable row level security;
-- oauth_tokens gets zero policies below on purpose: anon/authenticated can
-- never select/insert/update/delete it. Edge Functions use the service_role
-- key, which bypasses RLS entirely.

-- videos: the device can read everything (for the dashboard/queue UI) and
-- can create a row via register_video() below, but can never set status,
-- generated metadata, or YouTube ids itself — those columns are only ever
-- written by Edge Functions using the service_role key.
create policy "videos are readable by anon"
  on public.videos for select
  using (true);

-- settings: readable by anon, and updatable — but only the two columns the
-- app is allowed to change (upload_folder, default_visibility). We enforce
-- that with a trigger rather than a column-level grant, since RLS itself is
-- row-level, not column-level.
create policy "settings readable by anon"
  on public.settings for select
  using (true);

create policy "settings updatable by anon"
  on public.settings for update
  using (id = 1)
  with check (id = 1);

create or replace function public.guard_settings_update()
returns trigger language plpgsql as $$
begin
  -- Ignore any attempt from the client to flip connection state directly;
  -- only the OAuth callback Edge Function (service_role) may change these.
  new.youtube_connected     := old.youtube_connected;
  new.youtube_channel_id    := old.youtube_channel_id;
  new.youtube_channel_title := old.youtube_channel_title;
  return new;
end;
$$;

drop trigger if exists settings_guard_update on public.settings;
create trigger settings_guard_update
  before update on public.settings
  for each row execute function public.guard_settings_update();

-- upload_history: readable by anon, never writable by anon (Edge Functions
-- use service_role to insert).
create policy "upload_history readable by anon"
  on public.upload_history for select
  using (true);

-- ---------------------------------------------------------------------------
-- register_video(): the ONLY way the device can create a videos row.
-- SECURITY DEFINER lets it insert despite the table having no anon INSERT
-- policy, while pinning status/visibility to safe defaults regardless of
-- what the caller passes in.
-- ---------------------------------------------------------------------------
create or replace function public.register_video(
  p_filename       text,
  p_storage_path   text,
  p_thumbnail_path text default null
)
returns public.videos
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.videos;
  v_visibility text;
begin
  select default_visibility into v_visibility from public.settings where id = 1;

  insert into public.videos (filename, storage_path, thumbnail_path, status, visibility)
  values (p_filename, p_storage_path, p_thumbnail_path, 'pending', coalesce(v_visibility, 'private'))
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.register_video(text, text, text) to anon, authenticated;

-- ===========================================================================
-- Storage buckets
-- Run once (or create via Dashboard > Storage):
--   incoming-videos   -> private bucket, videos + thumbnails land here
--   thumbnails-public -> public bucket, ONLY the thumbnail is copied here by
--                        process-video so the UI can hotlink it without
--                        exposing the source video bucket.
-- ===========================================================================
insert into storage.buckets (id, name, public)
  values ('incoming-videos', 'incoming-videos', false)
  on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
  values ('thumbnails-public', 'thumbnails-public', true)
  on conflict (id) do nothing;

-- ===========================================================================
-- Database Webhook (set up in Dashboard: Database > Webhooks)
--   Name:     on-video-registered
--   Table:    public.videos
--   Events:   INSERT
--   Type:     HTTP Request
--   URL:      https://YOUR-PROJECT-REF.supabase.co/functions/v1/process-video
--   Headers:  Authorization: Bearer <service_role or a shared secret>
-- This fires process-video automatically the moment register_video() runs —
-- no polling required, and it fires even if the phone/app is closed by then.
--
-- (Alternative used in this project: wired directly via pg_net instead of
-- the Dashboard UI — see the trigger_process_video() function below.)
-- ===========================================================================

create extension if not exists pg_net;

create or replace function public.trigger_process_video()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/process-video',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := jsonb_build_object('type', 'INSERT', 'table', 'videos', 'record', to_jsonb(new))
  );
  return new;
end;
$$;

drop trigger if exists videos_after_insert_process on public.videos;
create trigger videos_after_insert_process
  after insert on public.videos
  for each row
  when (new.status = 'pending')
  execute function public.trigger_process_video();

-- ===========================================================================
-- Quota handling — see QUOTA.md for the full design rationale.
--
-- A video that hits any of YouTube's three quota/limit types (see QUOTA.md)
-- lands in status = 'quota_exceeded' instead of 'failed': the source file
-- and analyzed metadata are kept, and this daily cron job flips it back to
-- pending and re-triggers process-video once the daily reset has almost
-- certainly happened. No manual intervention needed for the common case.
-- ===========================================================================

create extension if not exists pg_cron;

create or replace function public.retry_quota_exceeded_videos()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  for r in select * from public.videos where status = 'quota_exceeded' loop
    update public.videos set status = 'pending' where id = r.id;
    perform net.http_post(
      url     := 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/process-video',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body    := jsonb_build_object('type', 'RETRY', 'table', 'videos', 'record', to_jsonb(r))
    );
  end loop;
end;
$$;

-- 08:15 UTC is after midnight Pacific Time whether it's PST (UTC-8) or
-- PDT (UTC-7), so this always runs after that day's YouTube quota reset.
select cron.schedule(
  'retry-quota-exceeded-videos',
  '15 8 * * *',
  $$select public.retry_quota_exceeded_videos()$$
);
