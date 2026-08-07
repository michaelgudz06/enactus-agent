# Enactus SFU lead agent

An internal, password-gated tool for the Enactus SFU External Relations team. It turns a
plain-English request into researched sponsor leads on a Kanban board, and drafts first-touch
outreach for a human to send.

`AGENTS.md` is the working guide for anyone changing the code. This file covers running it and
configuring it.

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # vitest, never touches the live Supabase project
npm run typecheck
npm run lint
npm run build
```

Deploying is not finished until the statements at the top of `supabase-setup.sql` have been run
against the live Supabase project.

## Environment

Credentials live in `.env.local`, which is gitignored. Never print, log or commit a value.

| Variable | Required | What it is |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | yes | Model calls. Both pinned models are DeepSeek via OpenRouter. |
| `EXA_API_KEY` | yes | Web search. The expensive half of the monthly budget. |
| `SUPABASE_URL` | yes | The dedicated Supabase project. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-only. Without it the app runs but saves nothing, and the API budget cap is per-process rather than per-month (the UI marks it "not persisted"). With it set, `supabase-setup.sql` must have been run: if `enactus_api_spend` is missing the month's spend cannot be read, and the agent and drafting refuse to run at all rather than guessing. |
| `APP_TEAM_PASSWORD` | yes | The single shared team password. |
| `SESSION_SECRET` | yes | Signs the session and Gmail cookies. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | for Gmail drafts | OAuth for creating drafts in a teammate's Gmail. |
| `OUTREACH_FROM_EMAIL` | recommended | The club's `@sfu.ca` inbox that outreach is sent from. Anything that is not an `@sfu.ca` address is refused, not used. |
| `API_BUDGET_CAD` | no | The monthly cap. Defaults to `20`. Anything unparseable, zero or negative falls back to `20` rather than lifting the cap. |
| `API_BUDGET_USD_TO_CAD` | no | FX rate for converting provider bills into the CAD cap. Defaults to `1.4024`, pinned 2026-08-06. |

## The monthly API budget

**$20 CAD a month, and it is a hard stop.** The pipeline refuses to start a run it cannot pay
for in full, and says so, naming the cap and what has been spent. It never half-runs, and it
never returns a short list as though it were complete.

The cap lives in `src/lib/budget.ts` and is enforced *inside* the provider clients
(`src/lib/llm.ts`, `src/lib/exa.ts`), so no caller can route around it. There is no flag to
skip it. The only way to change the number is `API_BUDGET_CAD`, which is the VP External's call.

Remaining budget is shown on the agent page before a run, and at `GET /api/budget`.

### What $20 CAD actually buys

Prices verified live on 2026-08-06 (OpenRouter's model list; `docs.exa.ai/reference/pricing`).
The only two paid providers are OpenRouter and Exa: Gmail is free at this volume, Supabase is a
flat free-tier project, and the domain checks go to the local DNS resolver.

One run, worst case, in CAD:

| Step | Cost | Share |
| --- | --- | --- |
| 3 Exa searches (6 results each) | $0.0295 | **74%** |
| Reasoning pass (`deepseek-v4-pro`) | $0.0063 | 16% |
| Structuring pass (`deepseek-v4-flash`) | $0.0037 | 9% |
| Planning pass (`deepseek-v4-flash`) | $0.0005 | 1% |
| **Total per run** | **$0.040** | |
| One outreach draft | $0.0004 | |

So **$20 CAD buys roughly 500 runs a month** at worst case, about 560 at typical usage — around
**3,000 companies researched**, since a run researches 6. Drafts are nearly free: about 46,000 of
them, so in practice they never move the number.

**The cap is not the binding constraint at current settings.** The club will not run the agent
500 times a month. What the numbers actually say is:

- **Searching is 74% of the bill.** Depth is close to free next to breadth: reasoning harder over
  the companies a search already found costs a fraction of searching again.
- **Results 7 through 10 of each search cost nothing.** Exa's $7/1k base price covers ten results
  with their page text; the agent currently asks for six. Raising `RUN_SHAPE.resultsPerSearch` to
  10 would research two-thirds more companies per run at *zero* extra cost. That is the single
  best value change available and it is deliberately not made here, because it changes what the
  ranking layer sees and that belongs with whoever owns ranking.
- If throughput ever does become the constraint, the number to revisit is `RUN_SHAPE.searchQueries`.

## Outreach sends from an SFU inbox

Drafts are written to be sent from the club's `@sfu.ca` address, which is what gives a cold email
to a Lower Mainland business the university's weight behind it. Set `OUTREACH_FROM_EMAIL`.

- A value that is not an `@sfu.ca` address (or a subdomain of it) is **refused**, not used. The
  draft still gets written, signed with an obvious placeholder, and says why.
- The sign-off is written by code, never by the model. An email address is a fact, and a model
  asked to write one will invent one.
- For the `From:` header on a Gmail draft to stick, that SFU address has to be added as a verified
  *send-as* alias on the connected Google account (Gmail → Settings → Accounts → Send mail as).
  Without that, Gmail replaces it with the account's own address.
- **The agent never sends.** A human presses send, from that inbox. See `AGENTS.md`.

The club still needs to confirm SFU's own policy on using university addresses for solicitation.
That is a club-side question and nothing in the code can enforce it.

## Attribution

Every action a signed-in person takes is recorded in `enactus_activity_log`: signing in, running
the agent, creating, editing or deleting a lead, generating a draft, and creating one in Gmail.

It stores the display name from the session, the action, and which record it happened to. **No
credential, session token or email body ever reaches it** — `scrubDetail` in `src/lib/activity.ts`
enforces that rather than trusting each call site, and it also strips contact names and addresses,
which belong on the lead and not in an audit line.

**This answers "who used the tool", not "who is accountable."** Privacy law wants a single
designated individual answerable for the whole database, permanently, whoever happens to be logged
in. That designation is a separate decision, it is still open, and it is deliberately recorded
nowhere in this repository. Do not read a name in this log as that person.
