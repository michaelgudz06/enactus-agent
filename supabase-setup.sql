-- ══════════════════════════════════════════════════════════════════
-- Enactus Lead Agent — one-time setup for the dedicated Supabase project
-- Paste this whole file into: Supabase → SQL Editor → New query → Run
--
-- ⚠ DEPLOYING TO A PROJECT THAT ALREADY HAS THESE TABLES? RUN THIS FIRST.
-- `create table if not exists` does nothing to an existing table, so a new
-- column never appears and EVERY lead insert fails. The agent now says so
-- loudly instead of showing leads it did not save, but the fix is here:
--
--   alter table public.enactus_leads add column if not exists contact_email_status text;
--   alter table public.enactus_leads add column if not exists website_status text;
--
-- Both are idempotent and repeated below with the rest of the migrations.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.enactus_leads (
  id uuid primary key default gen_random_uuid(),
  company text not null,
  website text,
  -- Set when the agent could not verify a model-claimed website. The claim is
  -- kept here, visible but never presented as the company's site.
  website_status text,
  industry text,
  description text,
  contact_name text,
  contact_role text,
  contact_email text,
  -- Set when the agent could not verify a model-supplied address. The address is
  -- kept here, unusable but visible, instead of being presented as a contact.
  contact_email_status text,
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

create table if not exists public.enactus_searches (
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

create table if not exists public.enactus_email_drafts (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references public.enactus_leads(id) on delete cascade,
  subject text,
  body text,
  gmail_draft_id text,
  status text default 'draft',
  created_by uuid,
  created_at timestamptz default now(),
  created_by_name text
);

-- Additive migrations for projects created before these columns existed.
-- `create table if not exists` above will not add them to an existing table.
alter table public.enactus_leads add column if not exists contact_email_status text;
alter table public.enactus_leads add column if not exists website_status text;

-- Lock the tables down. The app connects with the SECRET key (bypasses RLS),
-- so no public policies are needed; the publishable key can read nothing.
alter table public.enactus_leads        enable row level security;
alter table public.enactus_searches     enable row level security;
alter table public.enactus_email_drafts enable row level security;

-- ── Seed: 25 curated Lower Mainland contacts ──
insert into public.enactus_leads
(company, industry, description, contact_name, contact_role, contact_email, why_fit, sponsorship_type, connection_type, status, mode) values
($$Affinity Credit Union$$, $$Finance$$, $$Western Canada-based credit union supporting SK + BC communities. Active sponsor of Western Canadian student business competitions including JDC West.$$, $$Community Engagement Team$$, $$Sponsorships & Donations$$, $$sponsorship@affinitycu.ca$$, $$Named 2024 SFU JDC West sponsor — direct precedent of supporting SFU Beedie student programming. Easy follow-on ask from Enactus SFU.$$, ARRAY['monetary']::text[], 'past_sponsor', 'researched', 'sponsor'),
($$Neighbourhood Holdings$$, $$Finance$$, $$Vancouver-based non-bank mortgage lender providing alternative financing across BC. Privately held fintech with strong Lower Mainland roots.$$, $$Corporate Relations$$, $$Sponsorship & Partnerships$$, $$info@nhholdings.ca$$, $$Confirmed 2024 SFU JDC West sponsor. Already invests in SFU Beedie student events — natural cross-sell to Enactus SFU within the same school.$$, ARRAY['monetary']::text[], 'past_sponsor', 'researched', 'sponsor'),
($$PC Urban Properties$$, $$Real Estate$$, $$Vancouver-based urban real estate developer (since 2009). Industrial, commercial and residential projects across Western Canada — known for creative urban spaces.$$, $$Brent Sawchyn$$, $$CEO & Founding Partner$$, $$info@pcurban.ca$$, $$2024 SFU JDC West sponsor. Founder-led — Brent makes the call. Strong precedent of saying yes to SFU Beedie student initiatives.$$, ARRAY['monetary']::text[], 'past_sponsor', 'researched', 'sponsor'),
($$HeavyPDG Equipment Ltd.$$, $$Industrial$$, $$Lower Mainland heavy equipment dealer/contractor. Small-to-mid-size industrial business that punches above its weight in BC student community investment.$$, $$Owner / GM$$, $$Sales & Sponsorship$$, $$info@heavypdg.ca$$, $$Named 2024 SFU JDC West sponsor. Owner-operator businesses respond fastest to direct student outreach — pitch the in-kind angle (event venues, equipment).$$, ARRAY['monetary','in_kind']::text[], 'past_sponsor', 'researched', 'sponsor'),
($$Window Wizards$$, $$Industrial$$, $$Lower Mainland window cleaning & maintenance company. Locally owned small business with an active community sponsorship program.$$, $$Owner$$, $$General Manager$$, $$info@windowwizards.ca$$, $$2024 SFU JDC West sponsor. Small, founder-run — fastest possible yes. Great for in-kind contributions (services, raffle prizes) at Enactus events.$$, ARRAY['in_kind','monetary']::text[], 'past_sponsor', 'researched', 'sponsor'),
($$Vancity Credit Union$$, $$Finance$$, $$BC's largest credit union with $440M+ community investment since 1994. Grants up to $25K for social enterprises through their Community Partnership Program.$$, $$Community Investment Team$$, $$Grants & Sponsorships$$, $$sponsorship@vancity.com$$, $$Confirmed SFU JDC West sponsor + explicit grant programs for social enterprises. Direct fit with Enactus projects (Nourish, Unify, SKYES, Alara).$$, ARRAY['monetary']::text[], 'past_sponsor', 'researched', 'sponsor'),
($$Safe Software$$, $$Tech$$, $$Surrey-based data integration software company (FME). Founded 1993 by SFU alumnus Don Murray. 200+ employees, serves 10,000+ orgs in 100+ countries. B-Corp certified.$$, $$Don Murray$$, $$Co-Founder & CEO · SFU '85$$, $$info@safe.com$$, $$Co-founder is an SFU alumnus + 2026 SFU Outstanding Alumni Award recipient. Donated $2,500 to SFU Food Security. Sponsored SFU UAV team. Warmest possible lead.$$, ARRAY['monetary','in_kind']::text[], 'alum', 'researched', 'sponsor'),
($$Peak Products$$, $$Retail$$, $$Vancouver home renovation & outdoor-living products company. 1,000+ products sold exclusively in Home Depot stores across North America. Founded 1998 by SFU MBA alumnus.$$, $$John Gross$$, $$Founder & CEO · SFU MBA '97$$, $$info@peakproducts.com$$, $$John already gives $250K/year to SFU Charles Chang Institute for the John Gross Start-up Experience grants. Funding SFU student entrepreneurship IS his thesis — Enactus is his next natural ask.$$, ARRAY['monetary']::text[], 'alum', 'researched', 'sponsor'),
($$Superpilot$$, $$Tech$$, $$AI startup transforming commerce marketing, founded by ex-Mobify CEO Igor Faletski (whose first company was acquired by Salesforce). New SFU-grown venture.$$, $$Igor Faletski$$, $$CEO & Co-Founder · SFU BSc '07$$, $$hello@superpilot.ai$$, $$Igor serves on SFU's Faculty of Applied Sciences External Advisory Board, supports SFU co-op placements, and gives philanthropically to advance student experience. Active SFU advocate.$$, ARRAY['monetary','in_kind']::text[], 'alum', 'researched', 'sponsor'),
($$BAK'D Cookies$$, $$Food & Beverage$$, $$Vancouver gourmet cookie brand with $250K+ annual revenue. Founded April 2020 by Jessica Nguyen (SFU BBA '20) and her brother Andy out of their family townhouse.$$, $$Jessica Nguyen$$, $$Co-Founder · SFU BBA '20$$, $$hello@bakdcookies.com$$, $$Jessica was an Enactus SFU member (Bright Ideas) AND a JDC West competitor as a student. She literally was in your shoes — single warmest in-kind lead for event catering on the list.$$, ARRAY['in_kind','monetary']::text[], 'alum', 'researched', 'sponsor'),
($$Second Savour$$, $$Food & Beverage$$, $$Vancouver venture transforming rescued food ingredients into consumer products. Now launched in Save-On-Foods. BCBusiness 30 Under 30 2026 winner.$$, $$Justin Cheung$$, $$Founder · Enactus SFU member$$, $$hello@secondsavour.ca$$, $$Justin is a current/recent Enactus SFU member — Second Savour grew out of the Enactus program. Already family. Ask for product donations, mentor sessions, profile features.$$, ARRAY['in_kind']::text[], 'alum', 'researched', 'sponsor'),
($$The Woods Spirit Co.$$, $$Food & Beverage$$, $$Award-winning boutique craft distillery in North Vancouver. Acquired in late 2024 by serial entrepreneur Celia Chiang (SFU EMBA), whose daughter studies at SFU Beedie.$$, $$Celia Chiang$$, $$Owner & Operator · SFU EMBA$$, $$info@thewoodsspirit.com$$, $$Recent SFU EMBA grad with active family ties to Beedie (daughter is current undergrad). In-kind potential for 21+ Enactus events (gala, donor mixer). Personal SFU loyalty.$$, ARRAY['in_kind','monetary']::text[], 'alum', 'prospects', 'sponsor'),
($$pH7 Technologies$$, $$Life Sciences$$, $$Burnaby-based cleantech company commercializing greener methods for critical-minerals extraction. Founded in 2020 by SFU Beedie MBA alumnus.$$, $$Mohammad Doostmohammadi$$, $$Founder & CEO · SFU MBA$$, $$info@ph7technologies.com$$, $$SFU Beedie MBA alum building a venture-backed cleantech in Burnaby. Active in Innovate BC ecosystem. Perfect fit for Enactus sustainability projects (Alara, SensMS).$$, ARRAY['monetary','in_kind']::text[], 'alum', 'prospects', 'sponsor'),
($$IUVOX$$, $$Life Sciences$$, $$SFU health-tech startup building smart UV air-disinfection devices for dental offices. Spun out of SFU's TechE program with Chang Institute support.$$, $$Michelle De la O$$, $$Co-Founder · SFU BBA, TechE@SFU$$, $$hello@iuvox.com$$, $$Direct Chang Institute / Venture Connection alumna — Michelle was an SFU Beedie undergrad founder herself. Will absolutely respond to peer outreach from Enactus.$$, ARRAY['monetary','in_kind']::text[], 'alum', 'prospects', 'sponsor'),
($$Behené$$, $$Retail$$, $$Vancouver-based customized clothing brand launched at Vancouver Fashion Week 2013. Founded by SFU Beedie alumna and Young Women in Business member.$$, $$Jasmin Garcha$$, $$Co-Founder & Owner · SFU BBA$$, $$info@behene.com$$, $$Beedie + YWIB alumna who launched her business straight out of SFU. Small, owner-run — perfect for in-kind sponsorship (event swag, fashion-related Enactus projects).$$, ARRAY['in_kind']::text[], 'alum', 'prospects', 'sponsor'),
($$GluteNull$$, $$Food & Beverage$$, $$Port Coquitlam-based gluten-free wholesale bakery distributing nationally (Sobeys, Costco, Superstore, Save-On-Foods). CEO is a current SFU joint-major student.$$, $$Arshita Saini$$, $$CEO · SFU MolBio + Business$$, $$hello@glutenull.com$$, $$SFU student CEO who scaled GluteNull from packaging job to $1M+ growth before graduating. BCBusiness 30 Under 30 — will identify deeply with Enactus mission.$$, ARRAY['in_kind','monetary']::text[], 'alum', 'prospects', 'sponsor'),
($$Moment Energy$$, $$Industrial$$, $$Coquitlam-based clean-energy startup repurposing retired EV batteries into stationary energy-storage systems. SFU spinout via the Charles Chang Institute / Venture Connection.$$, $$Edward Chiang$$, $$Co-Founder & CEO · SFU MSE$$, $$hello@momentenergy.com$$, $$SFU spinout supported by Venture Connection (now Chang Institute). Coquitlam HQ — local. Sustainability mission directly aligned with Enactus Alara & Nourish.$$, ARRAY['monetary','in_kind']::text[], 'alum', 'prospects', 'sponsor'),
($$Ionomr Innovations$$, $$Life Sciences$$, $$Vancouver-based clean-energy materials company spun out of SFU. Develops hydrocarbon-based membranes for hydrogen energy, fuel cells and water treatment.$$, $$Bill Haberlin$$, $$CEO$$, $$info@ionomr.com$$, $$SFU research spinout that has scaled internationally. Leadership has direct lineage to SFU and the Chang Institute / Venture Connection ecosystem. Cleantech sustainability angle.$$, ARRAY['monetary']::text[], 'alum', 'prospects', 'sponsor'),
($$Mala the Brand$$, $$Retail$$, $$Vancouver-based eco-friendly home goods brand (candles, room sprays). SFU alumni-founded and graduated from SFU's Venture Connection incubator program.$$, $$Hannah Wood$$, $$Founder · SFU alumna, V.C. grad$$, $$hello@malathebrand.com$$, $$SFU alumni founders explicitly credit Venture Connection for early growth. Sustainable consumer brand = great in-kind fit (event swag, raffle prizes, gala).$$, ARRAY['in_kind','monetary']::text[], 'alum', 'prospects', 'sponsor'),
($$Spexi Geospatial$$, $$Tech$$, $$Vancouver-based drone & geospatial data platform that pays drone pilots to capture imagery. SFU alumni-founded, graduated from Venture Connection.$$, $$Bill Lakeland$$, $$Co-Founder & CEO$$, $$hello@spexi.com$$, $$SFU Venture Connection alum company. Drone/tech sector — could provide in-kind tech for Enactus digital projects (Unify) plus monetary sponsorship of tech events.$$, ARRAY['monetary','in_kind']::text[], 'alum', 'prospects', 'sponsor'),
($$Coast Capital Savings$$, $$Finance$$, $$One of BC's largest credit unions ($21B+ assets). Founding partner of SFU's flagship entrepreneurship program — Coast Capital Venture Connection — for 15+ years.$$, $$Make Good Happen Program$$, $$Community Investment$$, $$makegoodnow@coastcapitalsavings.com$$, $$Already named on SFU's flagship entrepreneurship program. Funds SFU student ventures via Venture Prize. Direct ecosystem alignment with Enactus.$$, ARRAY['monetary']::text[], 'ecosystem', 'researched', 'sponsor'),
($$Prospera Credit Union$$, $$Finance$$, $$BC credit union ($6.7B assets, 26 branches across Lower Mainland & Fraser Valley). Gave $1M+ to community in 2023 including post-secondary education grants.$$, $$Gavin Toy$$, $$President & CEO$$, $$mediarelations@prospera.ca$$, $$Confirmed Charles Chang Institute partner — sponsored Opportunity Fest 2021. Dedicated post-secondary education grants. Established SFU-entrepreneurship relationship.$$, ARRAY['monetary']::text[], 'ecosystem', 'researched', 'sponsor'),
($$Innovate BC$$, $$Non-profit / Gov$$, $$BC's provincial innovation Crown agency (formerly BCIC). Funds and supports BC's tech and innovation ecosystem — partners with SFU Venture Connection.$$, $$Programs & Partnerships$$, $$Community Impact Team$$, $$info@innovatebc.ca$$, $$Direct funding partner of SFU Charles Chang Institute / Venture Connection (2008-2024). Mandate explicitly aligned with student innovation & entrepreneurship.$$, ARRAY['monetary']::text[], 'ecosystem', 'prospects', 'sponsor'),
($$Dobson Foundation$$, $$Non-profit / Gov$$, $$Canadian family foundation focused on entrepreneurship and innovation in higher education. Long-time funder of SFU Venture Connection program.$$, $$Program Officer$$, $$Grants & Education$$, $$info@dobsonfoundation.ca$$, $$Named key funder of SFU Charles Chang Institute / Venture Connection. Mission is literally funding student entrepreneurship education — Enactus fits the thesis.$$, ARRAY['monetary']::text[], 'ecosystem', 'prospects', 'sponsor'),
($$Discovery Foundation$$, $$Non-profit / Gov$$, $$BC-based foundation supporting innovation, technology and entrepreneurship in British Columbia. Long-time supporter of SFU Venture Connection.$$, $$Program Director$$, $$Grants & Partnerships$$, $$info@discoveryfoundation.ca$$, $$Named key funder of SFU Charles Chang Institute / Venture Connection. BC-focused mandate aligned with Enactus SFU's social-entrepreneurship work.$$, ARRAY['monetary']::text[], 'ecosystem', 'prospects', 'sponsor');