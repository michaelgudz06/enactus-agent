-- ══════════════════════════════════════════════════════════════════
-- Enactus Lead Agent — one-time setup for the Neon Postgres database
-- Run with: node scripts/setup-db.mjs   (or paste into the Neon SQL editor)
--
-- No RLS here: the app is the only client and connects as the database
-- owner over a server-side DATABASE_URL. There is no anon/browser role to
-- lock out, so RLS would protect nothing. Keep DATABASE_URL server-only.
-- ══════════════════════════════════════════════════════════════════

create table if not exists enactus_leads (
  id uuid primary key default gen_random_uuid(),
  company text not null,
  website text,
  industry text,
  description text,
  contact_name text,
  contact_role text,
  contact_email text,
  location text,
  connection_type text default 'none',
  connection_note text,
  sponsorship_type text[] default '{}',
  fit_score integer,
  why_fit text,
  reasoning text,
  sources jsonb default '[]'::jsonb,
  status text not null default 'prospects',
  mode text not null default 'sponsor',
  board_order double precision default 0,
  search_id uuid,
  created_by uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  created_by_name text
);

create table if not exists enactus_searches (
  id uuid primary key default gen_random_uuid(),
  prompt text not null,
  normalized text,
  mode text default 'sponsor',
  params jsonb default '{}'::jsonb,
  result_count integer default 0,
  created_by uuid,
  created_at timestamptz default now(),
  created_by_name text
);

create table if not exists enactus_email_drafts (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references enactus_leads(id) on delete cascade,
  subject text,
  body text,
  gmail_draft_id text,
  status text default 'draft',
  created_by uuid,
  created_at timestamptz default now(),
  created_by_name text
);

-- Board reads order by (board_order, created_at) filtered on mode; history
-- reads the 40 most recent searches for a mode.
create index if not exists enactus_leads_board_idx
  on enactus_leads (mode, board_order, created_at desc);
create index if not exists enactus_searches_recent_idx
  on enactus_searches (mode, created_at desc);
create index if not exists enactus_email_drafts_lead_idx
  on enactus_email_drafts (lead_id);

-- ══════════════════════════════════════════════════════════════════
-- CRM tables — timeline, templates, map. Additive: every statement is
-- if-not-exists so this file stays runnable against a live database.
-- ══════════════════════════════════════════════════════════════════

-- Every material thing that happened to a lead, append-only. `meta` carries
-- the evidence (source URLs for a found contact, from/to for a stage move) so
-- a claim can be checked months later without re-running the scrape.
create table if not exists enactus_lead_activity (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references enactus_leads(id) on delete cascade,
  kind text not null,
  body text,
  meta jsonb default '{}'::jsonb,
  actor_name text,
  created_at timestamptz default now()
);

-- Who the email is from. Separate from templates because one person sends
-- several templates, and the signature belongs to the person.
create table if not exists enactus_senders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  title text,
  signature text,
  created_by_name text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists enactus_email_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  subject text,
  body text,
  sender_id uuid references enactus_senders(id) on delete set null,
  is_default boolean not null default false,
  created_by_name text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Areas to sweep, not a geometry system: a centre and a radius is enough to
-- ask "who have we not covered in Coquitlam yet". lead_count is stored rather
-- than counted live because the sweep endpoint recomputes it on demand.
create table if not exists enactus_territories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  lat double precision not null,
  lng double precision not null,
  radius_m integer not null default 8000,
  swept_at timestamptz,
  swept_by_name text,
  lead_count integer not null default 0
);

-- Map pins. geocoded_at is stamped even when nothing is found, so an
-- unplaceable location is not retried forever.
alter table enactus_leads add column if not exists lat double precision;
alter table enactus_leads add column if not exists lng double precision;
alter table enactus_leads add column if not exists geo_precision text;
alter table enactus_leads add column if not exists geocoded_at timestamptz;

alter table enactus_email_drafts add column if not exists template_id uuid;
alter table enactus_email_drafts add column if not exists sender_id uuid;

-- The timeline is always read newest-first for one lead; the geocode queue is
-- always "located but not yet placed".
create index if not exists enactus_lead_activity_lead_idx
  on enactus_lead_activity (lead_id, created_at desc);
create index if not exists enactus_leads_geocode_queue_idx
  on enactus_leads (geocoded_at) where location is not null;

-- One default template, enforced by the database rather than by remembering to
-- clear the old one in every write path.
create unique index if not exists enactus_email_templates_one_default
  on enactus_email_templates ((true)) where is_default;
