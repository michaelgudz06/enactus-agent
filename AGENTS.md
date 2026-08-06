<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Enactus SFU lead agent

An internal, password-gated tool for the Enactus SFU External Relations team. It
turns a plain-English request into researched sponsor (or B2B sales) leads on a
Kanban board, and drafts first-touch outreach for a human to send.

The club is a volunteer student group whose exec turns over every year. The rules
below exist because breaking them costs the club its credibility with real local
businesses, and the person who has to apologise is a student. Keep them.

## Rules

### Never invent an email address or a domain

The model may *report* a contact address; only code decides whether it is real.
Every model-supplied address goes through `src/lib/contact.ts` (format gate, then
MX with an A/AAAA fallback) before it can be persisted. An address that fails is
recorded on the lead as `contact_email_status` and is never presented as a
contact — and the lead itself is kept, because the company may still be worth
pursuing even when the address is not usable.

Company websites go through the same gate, whichever route they arrive by —
claimed by the model or derived from a search result. Never synthesise one from
an aggregator or social URL: a LinkedIn post about a bakery is evidence, not the
bakery's website. A claim that fails is recorded as `website_status` and the lead
is kept, exactly as with an address.

This is not hypothetical. Live testing caught the agent inventing
`momentenergy.co` (no A record, no MX) for a company whose real domain is
`momentenergy.ca`, and the hand-seeded data shipped with four invented domains.

### Never claim a tax receipt

Enactus SFU is **not a qualified donee** under the Income Tax Act and cannot
issue a charitable receipt for anything. Never write "tax deductible", "tax
receipt", "charitable receipt", or any equivalent in outreach or UI copy. Offer
what the club can actually give: logo placement, event presence, student talent,
project association.

### Never target other student clubs, or anything that charges us

Sponsorship means a company gives the club money or in-kind support. It is not
something the club pays to join. Exclude other student clubs and university
associations at any school, paid memberships, paid directory listings, ticketed
programs, and fee-based accelerators. Chambers of commerce and business
associations that charge dues are out for the same reason.

### Code decides, the model reports

The model proposes; code verifies and has the last word. Anything a model
produces that becomes a stored fact must pass a check written in code first:
bounds-check every index into a list the model was shown, verify every domain,
schema-validate every JSON response, and reject rather than coerce. When a check
fails, report it honestly — do not throw the work away and blame the model, and
never present unverified data as verified.

Rejection is scoped to the thing that failed. A bad field costs that field, an
unusable record costs that record, and neither may cost the rest of the batch:
`reviewLeads` in `src/lib/agent.ts` checks each lead on its own and emits what it
dropped. Never validate a batch of leads atomically — one wrong-typed field
taking every lead with it is the exact failure this agent was repaired for.

### Drafts only, never send

`src/lib/gmail.ts` uses the `gmail.compose` scope deliberately. A human presses
send, which is where CASL liability belongs. **Do not add a send path.**

## Working in this repo

- `npm test` runs the vitest suite. Tests must never reach the live Supabase
  project: with `SUPABASE_SERVICE_ROLE_KEY` unset the agent falls back to an
  in-memory lead, which is what the suite relies on.
- `src/lib/llm.ts` pins the exact published model ID — dated where the provider
  publishes a dated variant, undated where it does not — and never a floating
  `-latest` alias, so a quality regression can be attributed to a model change.
  The reasoner is undated because OpenRouter publishes no dated variant of it;
  that is not a violation, do not "correct" it. The reasoning /
  structured split is load-bearing: **never ask a reasoning model for JSON** — it
  answers in the reasoning channel and leaves `content` empty. `chatJSON`
  enforces this and will throw.
- `src/lib/enactus.ts` is hand-written institutional knowledge about the club and
  its eight projects. No model can regenerate it. Keep it verbatim.
- `supabase-setup.sql` is the schema source of truth. `create table if not
  exists` will not add a column to an existing project, so any new column also
  needs an `alter table ... add column if not exists` line in the same file.
- Credentials live in `.env.local`, which is gitignored. Never print, log, or
  commit a secret value.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
