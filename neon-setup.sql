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

-- The one thing stopping the same sponsor appearing twice. `insert ... on
-- conflict do nothing` in agent.ts is what keeps a re-run of "10 leads from
-- Burnaby" from duplicating the board, and on conflict needs THIS index to have
-- something to conflict against -- without it the clause is a no-op that fails
-- open. It was created by hand on the live database and never written down, so
-- a rebuild from this file came up silently missing it. lower(btrim(...)) so
-- "Purdys Chocolatier " and "purdys chocolatier" are one company. Per mode,
-- because sponsor mode and sales mode are separate boards.
create unique index if not exists enactus_leads_company_uniq
  on enactus_leads (mode, lower(btrim(company)));
create index if not exists enactus_searches_recent_idx
  on enactus_searches (mode, created_at desc);
create index if not exists enactus_email_drafts_lead_idx
  on enactus_email_drafts (lead_id);

-- ══════════════════════════════════════════════════════════════════
-- CRM tables — timeline, senders, templates. Additive: every statement is
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

alter table enactus_email_drafts add column if not exists template_id uuid;
alter table enactus_email_drafts add column if not exists sender_id uuid;

-- ══════════════════════════════════════════════════════════════════
-- Pipeline value, ownership, and outcome. Between them these four
-- columns answer the questions a VP External actually gets asked:
-- what is the pipeline worth, what closed this term, who owns what.
-- ══════════════════════════════════════════════════════════════════

-- Whole CAD dollars, and the ONLY hand-typed field of the set: the board asks
-- for it once, natively, when a card is dropped into Closed / Won. Integer
-- rather than numeric because Neon returns numeric as a string and this column
-- exists to be summed.
alter table enactus_leads add column if not exists amount integer check (amount >= 0);

-- Stamped by PATCH /api/leads/[id] when a card enters a closed stage, and
-- nulled when it is dragged back out. Never typed. "What did we close this
-- term" is this column and nothing else.
alter table enactus_leads add column if not exists closed_at timestamptz;

-- Filled by code: coalesced to the session name of whoever first drags the card
-- out of Prospects, overridable through the same PATCH (the Claim button).
alter table enactus_leads add column if not exists owner_name text;

-- The recipient of record. POST /api/gmail/create has always received `to` and
-- thrown it away, so a draft could never say where it went.
alter table enactus_email_drafts add column if not exists to_email text;

-- The stage vocabulary, enforced by the database rather than by remembering to
-- guard every write path. The route that interpolated b.status raw is gone and
-- every remaining writer validates, so this is now belt-and-braces -- which is
-- the point: a typo here files a card under a stage no column renders, leaving
-- no way to drag it back. ADD CONSTRAINT has no IF NOT EXISTS, hence the DO block, which
-- is what keeps this file rerunnable against a live database.
do $$ begin
  alter table enactus_leads add constraint enactus_leads_status_chk
    check (status in ('prospects','researched','outreach_sent','in_conversation','closed_won','closed_lost'));
exception when duplicate_object then null; end $$;

-- The timeline is always read newest-first for one lead.
create index if not exists enactus_lead_activity_lead_idx
  on enactus_lead_activity (lead_id, created_at desc);

-- One default template, enforced by the database rather than by remembering to
-- clear the old one in every write path.
create unique index if not exists enactus_email_templates_one_default
  on enactus_email_templates ((true)) where is_default;

-- Append-only ledger of what the agent has spent at the API providers. One row
-- per paid call. `month` is the calendar month in America/Vancouver (see
-- src/lib/budget.ts), stored rather than derived so the monthly total is a
-- plain indexed equality scan and does not depend on the server's timezone.
create table if not exists enactus_spend (
  id bigserial primary key,
  month text not null,
  provider text not null,
  detail text,
  cost_usd numeric(12, 6) not null check (cost_usd >= 0),
  created_at timestamptz not null default now()
);

create index if not exists enactus_spend_month_idx on enactus_spend (month);

-- ══════════════════════════════════════════════════════════════════
-- Sending. One shared club mailbox rather than a Google account per
-- volunteer: replies have to land somewhere that outlives the person
-- who sent the email, and External Relations turns over every year.
-- ══════════════════════════════════════════════════════════════════

-- Exactly one row, enforced by the key rather than by remembering to delete the
-- old one: `id` can only ever be true, so reconnecting is an upsert.
--
-- The refresh token is the entire credential. Anything that can read this table
-- can send mail as the club, which is the same trust level DATABASE_URL already
-- carries -- but it is newly true of OUTBOUND MAIL, so treat a leak of this
-- table as a leak of the club's voice, not just of its data.
create table if not exists enactus_mailbox (
  id boolean primary key default true check (id),
  email text not null,
  refresh_token text not null,
  connected_by_name text,
  connected_at timestamptz default now(),
  last_synced_at timestamptz
);

-- What actually left the building, and who sent it.
--
-- status was 'draft' | 'created_in_gmail'; 'sent' is the new terminal value.
-- gmail_thread_id is stored at send time because reply detection walks it, and
-- it cannot be recovered afterwards without searching the whole mailbox.
--
-- channel splits the LinkedIn composer's output from the email one. Without it
-- the two share a row per lead and each regeneration overwrites the other.
alter table enactus_email_drafts add column if not exists channel text not null default 'email';
alter table enactus_email_drafts add column if not exists sent_at timestamptz;
alter table enactus_email_drafts add column if not exists sent_by_name text;
alter table enactus_email_drafts add column if not exists gmail_thread_id text;
alter table enactus_email_drafts add column if not exists gmail_message_id text;

-- Note for anyone rebuilding: the live database still carries enactus_territories
-- and the lat/lng/geo_precision/geocoded_at columns from the map, which was
-- removed. Nothing reads them any more. They are left in place rather than
-- dropped because dropping a column cannot be undone and an unused one costs
-- nothing; drop them by hand if you want the schema tidy.
