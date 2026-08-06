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

## Commands

`npm test` (vitest, `tests/**/*.test.ts`) · `npm run typecheck` · `npm run lint` · `npm run build`

## Rules

### Never invent an email address or a domain

The model may *report* a contact address; only code decides whether it is real.
Every model-supplied address goes through `src/lib/contact.ts` (format gate, then
MX with an A/AAAA fallback) before it can be persisted. An address that fails is
recorded on the lead as `contact_email_status` and is never presented as a
contact — and the lead itself is kept, because the company may still be worth
pursuing even when the address is not usable.

Company websites are gated by how much the code actually knows. A domain the
model *claims* is a claim: it is format-checked and has to resolve, and a claim
that fails is recorded as `website_status` while the lead is kept, exactly as
with an address. A hostname taken from a search result is evidence the code
observed, so it is not re-verified — but it still goes through the aggregator
check, because an aggregator or social host is never the company's own website
whichever route it arrives by. A LinkedIn post about a bakery is evidence, not
the bakery's website.

This is not hypothetical. Live testing caught the agent inventing
`momentenergy.co` (no A record, no MX) for a company whose real domain is
`momentenergy.ca`, and the hand-seeded data shipped with four invented domains.

### Never claim a tax receipt

Enactus SFU is **not a qualified donee** under the Income Tax Act and cannot
issue a charitable receipt for anything. Never write "tax deductible", "tax
receipt", "charitable receipt", or any equivalent in outreach or UI copy. Offer
what the club can actually give: logo placement, event presence, student talent,
project association.

This is also why `K-CHAN-02` in `src/lib/filter.ts` treats a published
registered-charity requirement as terminal and records the SFU Advancement
escalation instead: the club cannot meet it.

### Never target other student clubs, or anything that charges us

Sponsorship means a company gives the club money or in-kind support. It is not
something the club pays to join. Exclude other student clubs and university
associations at any school, paid memberships, paid directory listings, ticketed
programs, and fee-based accelerators. Chambers of commerce and business
associations that charge dues are out for the same reason.

`K-ORG-02` and `K-ORG-03` in `src/lib/filter.ts` enforce this deterministically.

### Code decides, the model reports

The model proposes; code verifies and has the last word. Anything a model
produces that becomes a stored fact must pass a check written in code first:
bounds-check every index into a list the model was shown, verify every domain,
schema-validate every JSON response. Never fabricate a value the model did not
supply, and never present unverified data as verified.

A wrong type is read only when it has exactly one possible reading — `fit_score`
of `"88"` is a slip, not an ambiguity, so `recoverValue` in `src/lib/agent.ts`
reads it as 88 and reports the recovery. Anything open to interpretation
(`"high"`) is not guessed at: the field is left at its default. Both are
announced on the activity stream, because a silent repair teaches nobody that
the model is misbehaving. Do not "restore" a stricter rule by deleting that
recovery — losing a usable score to a typo was a real defect.

Rejection is scoped to the thing that failed. A bad field costs that field, an
unusable record costs that record, and neither may cost the rest of the batch:
`reviewLeads` checks each lead on its own and emits what it changed or dropped.
Never validate a batch of leads atomically — one wrong-typed field taking every
lead with it is the exact failure this agent was repaired for.

The same honesty applies to storage. A failed insert must never be dressed up as
a saved lead: `persistLead` returns whether the row was actually written, the run
reports every failure with the database's own message, and the UI only claims
leads reached the board when they did.

### Drafts only, never send

`src/lib/gmail.ts` uses the `gmail.compose` scope deliberately. A human presses
send, which is where CASL liability belongs. **Do not add a send path.**

## The qualification layer

`src/lib/filter.ts` (disqualifiers) and `src/lib/scoring.ts` (ICP) implement two written
specifications. **Read the spec before changing a rule** — they carry measurements and citations
the code does not repeat:

- `/Users/test/firstmate/data/enactus-disqualifiers/report.md` — kill predicates, soft penalties,
  franchise handling, the maintained lists
- `/Users/test/firstmate/data/enactus-icp/report.md` — the 17 segments, assignment precedence,
  hard gates, starting weights
- `/Users/test/firstmate/data/enactus-org/report.md` — why the rules are what they are

Four invariants these modules exist to hold. Breaking one silently is the failure mode:

1. **No model call in either module, ever** — not as a fallback. Both have a test asserting they
   import no model client.
2. **Hard kills and soft penalties stay separate.** A wrongly killed account is invisible
   forever; a wrongly penalised one still surfaces. Kill only when the account can never be a
   sponsor at any price, contacting it would be unlawful, or the right action is a different
   channel. When in doubt, penalise. Every terminal carries two orthogonal qualifiers taken
   verbatim from the report's Outcome and Suppression-window columns: a `scope`
   (`account` | `address` | `email` | `person` — only `account` drops the row, the rest clear what
   they name and keep evaluating) and a `duration` (`forever` | `until_human_clears` | `until`).
   A terminal may also emit a `SiblingPenalty` onto OTHER rows; it is never summed into this one.
3. **Missing data is never a kill.** Predicates return an explicit `cannot_evaluate` outcome
   carrying the missing field names.
4. **Never blend the scores.** `fit` / `affinity` / `access` stay separate, and so do the two
   objectives (`deployable_cash` vs `relationship_volume`). For Tier B segments the cash
   objective is *not applicable*, not zero.

## Policy lives in `config/`, not in code

`config/icp.yaml` (scoring weights) and `config/exclusions/*.csv` (the maintained lists) are
edited by the VP External Relations, not by a programmer — see `config/exclusions/README.md` for
ownership, cadence and regeneration commands. `loadIcpConfig()` validates that each score block's
weights sum to 100 and rejects the file otherwise.

Domain values in those CSVs are **verified, never guessed**: the disqualifier report caught two
plausible-looking domains that belonged to entirely different organisations. Verify before adding
a row, and leave `value` blank with a note rather than asserting an unverified domain.

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
  **Deploying is not done until those statements have been run against the live
  project.** Until they are, every insert fails on the missing column; the agent
  now reports that instead of showing leads it did not save, but the leads are
  still lost. The statements are listed at the top of the file for whoever
  deploys, and repeated with the other migrations.
- Credentials live in `.env.local`, which is gitignored. Never print, log, or
  commit a secret value.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
