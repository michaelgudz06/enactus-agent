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

### Alumni are people, not leads

`config/alumni/past-executives.csv` is a reconstruction of the club's past
executives from its own archived pages — the club holds no master alumni sheet.
An alum's connection to this club is *personal* information about them: outside
PIPEDA's business-contact exemption, outside BC PIPA's contact-information
carve-out, and BC PIPA has a live private right of action. So the file holds name,
role and years and nothing else — never an address, a phone number, an employer,
or anything from LinkedIn, which is never fetched. It is a **research seed for
recognising a connection to a company the pipeline already found, never a contact
list**; the repository stays private; and a named person can ask to be removed on
any day for any reason. `config/alumni/README.md` is authoritative and carries the
removal procedure — read it before touching that directory or wiring it into the
pipeline.

### Attribution is not accountability

`src/lib/activity.ts` records who was signed in for each action: creating,
editing or deleting a lead, generating a draft, running the agent, signing in.
Name, action, record id. **No credential, session token or email body ever
reaches that table** — `scrubDetail` enforces it on every entry rather than
trusting each call site, and it also strips contact names and addresses, which
belong on the lead and not in an audit line. `detail` holds primitives only so
nothing nested can smuggle a secret past it.

Two different things are easily conflated here, and only the first is built.
Privacy law wants **one designated individual** answerable for the whole
database, permanently, whoever happens to be logged in — it does not rotate per
session, which is the entire point of designating someone. That decision is open
and is **deliberately recorded nowhere in this repository**. Do not name anyone
as accountable in code, config or docs, and do not read a name in the activity
log as that person.

### Code decides, the model reports

The model proposes; code verifies and has the last word. Anything a model
produces that becomes a stored fact must pass a check written in code first:
bounds-check every index into a list the model was shown, verify every domain,
schema-validate every JSON response. Never fabricate a value the model did not
supply, and never present unverified data as verified.

A wrong type is read only when it has exactly one possible reading — `fit_score`
of `"88"` is a slip, not an ambiguity, so `recoverValue` in `src/lib/review.ts`
reads it as 88 and reports the recovery. A lone value where a list was asked for
reads as a list of one and a list of one where a lone value was asked for reads
as that value, and an unusable entry in a list costs that entry rather than the
list. That mirrored pair is what lets all three envelopes model output arrives
in — the plan, the leads response and the draft — read the same way. Anything
open to interpretation (`"high"`, or `"yes"` for a boolean) is not guessed at:
the field is left at its default. All of them are announced on the activity
stream, because a silent repair teaches nobody that the model is misbehaving.
Do not "restore" a stricter rule by deleting a recovery — losing a usable score
to a typo was a real defect.

### Validation annotates, it does not abort

A validation failure costs the smallest thing that actually failed, and nothing
more. It stops work only when the next step genuinely cannot run. A malformed
optional field costs that field, a recoverable one is normalised, a malformed
required field costs the record that carries it, and none of them may cost the
run.

`src/lib/review.ts` is the one mechanism that enforces this, and every level
reads model output through it: `reviewPlan` and `reviewLeads` in
`src/lib/agent.ts`, and the draft route. Do not add a second, parallel path —
that is how the same failure shape kept reappearing. It was fixed three times,
one level higher each time: a bad field killed a lead, then killed the whole
batch, then killed the entire run before a single search. It is stated here at
the level of the principle so a fourth level cannot appear.

Locally, check the envelope and nothing more. A schema handed to `chatJSON` that
type-checks properties makes one cosmetic field fatal to everything beside it —
a wrong-typed `altAngle`, a hint about a different search angle, used to end the
run on "Planning failed" while the search queries next to it were perfectly
good. The strict schema still goes to the provider; see `PLAN_SCHEMA` and
`LEADS_SCHEMA` for the two views of one shape.

A genuine blocker still stops the run, and says what was missing. A plan with no
usable `searchQueries` means there is nothing to search: that is a real stop and
must stay one. Never soften it into a warning, and never widen it back out to
cover fields the next step does not need — `criteria` sharpens the ranking
prompt that already carries the user's request, so losing it degrades the run
rather than ending it.

The same honesty applies to storage. A failed insert must never be dressed up as
a saved lead: `persistLead` returns whether the row was actually written, the run
reports every failure with the database's own message, and the UI only claims
leads reached the board when they did.

### The $20 CAD monthly cap is a stop, not a budget line

`src/lib/budget.ts` is the only mechanism. It meters the two providers that cost
money — OpenRouter (`src/lib/llm.ts`) and Exa (`src/lib/exa.ts`) — against a hard
$20 CAD/month cap, and the README says what that buys.

Three properties hold it together, and each exists because the alternative is a
run that looks finished and is not:

- **The check is inside the provider clients**, before the fetch, not at their
  call sites. No caller can route around it and **no function takes a skip
  flag**. A cap a caller can wave away is not a cap. Do not add an argument that
  bypasses it, including "just for tests" — the tests set the ledger instead.
- **A run either happens in full or does not start.** `runAgent` prices its own
  worst case up front and refuses cleanly, naming the cap and the spend. Never
  soften this into a smaller run: partial leads that look complete are the
  failure class this codebase was repaired for four times.
- **A budget stop must never wear the clothes of a degradation.** Every catch in
  the pipeline that keeps a run alive through a bad model response re-throws
  `BudgetExceededError` through `rethrowIfBudget`, because otherwise "we ran out
  of money" arrives as "no candidates found" or "ranking from the research
  instead". `tests/agent-budget-stop.test.ts` holds that, one test per catch.

Unknown spend is treated as spent: a ledger that cannot be read stops the work
rather than assuming zero, and a failed read is never cached as a clean month.
An unpriced model is charged at the dearest known rate, never free — so a new
pin in `src/lib/llm.ts` needs a price in `OPENROUTER_PRICES` or the cap starts
guessing. `RUN_SHAPE` is where the run's shape lives so the estimate and the
pipeline cannot drift apart.

### Outreach comes from an SFU inbox, and code writes the sign-off

`src/lib/sender.ts`. `OUTREACH_FROM_EMAIL` must be an `@sfu.ca` address;
anything else is **refused rather than used**, because quietly signing from a
personal mailbox defeats the ruling while looking fine. Unconfigured still
drafts, with an obvious bracketed placeholder — a guard that stops a student
drafting because an env var is missing is worse than no guard.

The signature is appended by code and the model is told not to write one. That
is the same rule as `src/lib/contact.ts`: an address is a fact, and a model asked
for one invents one.

### Drafts only, never send

`src/lib/gmail.ts` uses the `gmail.compose` scope deliberately. A human presses
send, which is where CASL liability belongs. **Do not add a send path.**

If you are the person who eventually wires one: **a passing score is not permission
to email.** `evaluateGates` in `src/lib/scoring.ts` answers `G_LAWFUL_BASIS` with
`not_applicable` whenever the email channel is closed — the gate asks whether this
lead may be *emailed*, and an unreachable row is not an unqualified one. So a lead
whose claimed CASL basis was found INVALID (L-04, P-08-CONSTRAINT) comes back with
`blocked: false` and every gate passing. `ScoreResult.blocked` is therefore not a
sufficient pre-send check.

`FilterResult.email_channel_open` / `CompanyFacts.email_channel_open` is the
operative protection. A send path must refuse a closed-channel lead
**structurally** — make it impossible to construct the send, rather than trusting a
caller to remember the flag. That is the same rule as `persistLead` returning
whether the row was written: the type carries the fact, not a convention.

## The qualification layer

`src/lib/filter.ts` (disqualifiers) and `src/lib/scoring.ts` (ICP) implement two written
specifications. **Read the spec before changing a rule** — they carry measurements and citations
the code does not repeat:

- `/Users/test/firstmate/data/enactus-disqualifiers/report.md` — kill predicates, soft penalties,
  franchise handling, the maintained lists
- `/Users/test/firstmate/data/enactus-icp/report.md` — the 17 segments, assignment precedence,
  hard gates, starting weights
- `/Users/test/firstmate/data/enactus-org/report.md` — why the rules are what they are

Those reports contradict themselves in five places. Every one is listed, with the reading taken
and why, in the REPORT CONTRADICTIONS block at the head of `src/lib/filter.ts` (the ICP one is at
`assignSegment` in `src/lib/scoring.ts`). The governing rule is **a rule's definition governs; a
later procedure section may not widen it**. Add to that block rather than patching silently.

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
   carrying the missing field names. Every rule also carries an explicit ENTRY CONDITION — "does
   this rule apply to this row at all?" — taken from its own definition row. An unproven condition
   on an entity the rule does not cover is a no-op, not a penalty.
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
  in-memory lead, which is what the suite relies on. A test that mocks
  `@/lib/supabase` wholesale must export every table constant the code under
  test touches (`SPEND` and `ACTIVITY` included) — vitest throws on a missing
  one, and the budget gate reads it before anything else runs.
- Provider prices in `src/lib/budget.ts` are **verified live, never guessed**,
  and dated in the file. Re-verify against `GET
  https://openrouter.ai/api/v1/models` and `docs.exa.ai/reference/pricing` when a
  model pin moves. The README carries what the cap buys, measured.
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
  deploys, and repeated with the other migrations. `enactus_api_spend` and
  `enactus_activity_log` are new tables rather than columns, so the file does
  create them — but until it is run against a project whose service key is set,
  the month's spend cannot be read, and unknown spend is spent: **the agent and
  the draft route refuse to run at all** rather than degrading. Nothing is
  attributed either, and that one is reported rather than fatal. The cap is only
  per-process in the other state — no service key set at all — and the UI marks
  that "not persisted".
- Credentials live in `.env.local`, which is gitignored. Never print, log, or
  commit a secret value. Variable names are documented in the README; add new
  ones there.
- **Run `npm ci` after any commit that changes `package.json`.** `js-yaml` is a
  direct dependency at 5.x, and eslint pulls a transitive 4.x; before the direct
  dependency existed, eslint's copy was the one hoisted to `node_modules/js-yaml`.
  A tree installed before then and never reinstalled therefore still resolves
  `js-yaml` to 4.x, which ships no type declarations at all, and `npm run
  typecheck` fails with `TS7016 ... js-yaml/dist/js-yaml.mjs`. The fix is
  reinstalling, never `@types/js-yaml` — its latest (4.0.9) describes the **4.x**
  API and would shadow 5.x's correct bundled declarations with wrong ones. Every
  5.x release exports a `types` condition that `moduleResolution: "bundler"`
  already reads, so `tsconfig.json` is not implicated.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
