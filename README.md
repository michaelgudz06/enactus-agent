# Enactus SFU — Lead Agent

Sponsor prospecting and pipeline tracking for the Enactus SFU External Relations
team. You describe the sponsors you want in plain English; the app searches the
open web, qualifies what it finds, and drops the survivors into a pipeline the
team works out of for the rest of the year.

It replaces the spreadsheet-and-shared-inbox setup that used to get rebuilt from
scratch at every executive handover.

## Why it exists

External Relations turns over completely each year. The prospect list, the
notes on who already said no, and the reason a company was worth approaching all
used to live in one outgoing VP's head. This keeps them in a database instead.

## What it does

| Page | Purpose |
| --- | --- |
| `/agent` | Describe a target ("bakeries in Burnaby that sponsor student events"). Streams its reasoning while it works. |
| `/board` | Kanban pipeline: Prospects → Researched → Outreach Sent → In Conversation → Closed. Drag to advance; closing a win asks for the dollar value. |
| `/leads` | Flat CRM list with sort, search, and filters by industry, owner, status, and missing contact info. |
| `/scoreboard` | Who did what: messages sent, replies earned, contacts added by hand, sponsorships closed. Weekly, monthly, all-time. |
| `/settings` | Club mailbox, sender identities, outreach templates, CSV export. |

### Outreach

Every lead opens a composer with two channels. **Email** drafts a subject and
body, both editable, and sends from the shared club Gmail with one button —
behind a confirm that names the recipient, because a send has no undo. Sending
stamps the draft row, moves the card to Outreach Sent, and writes the timeline
entry; sending the same draft twice reports the first send instead of
delivering a duplicate. **LinkedIn DM** writes a short message with no subject
and no links, plus a search link to find the person; nothing can send a DM for
you, so it offers *Mark as sent* and logs that instead of pretending.

Nothing is ever sent automatically. Every send is a person reading the message
and clicking the button.

**Replies** are the one thing the app cannot see happen — they land in Gmail.
*Check for replies* on the scoreboard walks the threads of messages that were
sent and stamps the first inbound one. Credit goes to whoever sent it, not to
whoever pressed the button.

### Scoreboard

Counts only what a person did: messages sent on either channel, replies those
messages earned, contacts typed in by hand, and sponsorships closed. The
agent's own contact lookups are deliberately excluded — a leaderboard the robot
wins is not a leaderboard.

Names are grouped case-insensitively, because the login box takes free text and
the board already held `michael` and `Michael` as two different people.

### Slack

Closing a sponsorship as **in-kind** posts an announcement naming the company,
what was given, and who landed it. In-kind wins are the ones that otherwise go
unnoticed: no invoice, no number on the board, just someone who talked a bakery
into donating.

It fires on `won_type`, which the person closing the deal sets — never on
`sponsorship_type`, which is what the model guessed at discovery time. Set
`SLACK_WEBHOOK_URL` to an incoming webhook; without it, closing still works and
nothing is posted.

## How a run works

1. **Search** — Google Places finds the businesses themselves (the channel
   that reliably surfaces the independent storefronts this club wins) and Exa
   queries the open web alongside it. Places results are then given real page
   text so they can be reasoned about rather than judged on a street address.
2. **Reason** — DeepSeek R1 (via OpenRouter) argues each candidate against the
   club's actual asks, streaming its reasoning to the page.
3. **Structure** — a fast model turns that prose into rows.
4. **Qualify** — Apollo confirms the company is real, still trading, and in the
   right region. Chambers of commerce, trade associations, and anything Enactus
   would have to *pay* to join are dropped here.
5. **Persist** — survivors are written to Neon and appear on the board mid-run.
6. **Find someone** — the top few leads get a contact lookup, and each is
   re-scored the moment a real person is found. The three strongest signals the
   club has are contact-level, so a board ordered before this step is ordered
   by the weaker half of the rubric.

One invocation is a 60-second serverless function, so a run tops out at 25
leads. Asking for more says so and tells you to run it again.

Discovery, reasoning and structuring used to share that one budget, which
meant a slow search was paid for by the stage that produces the leads. When
discovery leaves too little of the clock to reason properly, the run now parks
its candidates on the run row and the page picks it straight back up with a
fresh budget. Usually there is time to spare and it just runs on; either way
it is one turn in the transcript.

### Ground rules baked into the code

These are enforced in code, not in prompts, because a prompt is a suggestion:

- **No invented facts.** A name, email, or number survives only if it appears
  verbatim in fetched evidence. Every figure on screen is computed in TypeScript
  from stored values — none is model output.
- **No scraping LinkedIn.** Public pages via Exa, company sites via Firecrawl,
  and search links for a human to click. That is the whole contact pipeline.

## Running it locally

```bash
npm install
npm run dev
```

Then create `.env.local`:

```
DATABASE_URL=            # Neon connection string
OPENROUTER_API_KEY=      # DeepSeek R1 + structuring model
EXA_API_KEY=             # candidate search
APOLLO_API_KEY=          # qualification (optional; run degrades, never breaks)
FIRECRAWL_API_KEY=       # contact lookup (optional)
GOOGLE_PLACES_API_KEY=   # local business lookup (optional)
GOOGLE_CLIENT_ID=        # club mailbox: sending from the board (optional)
GOOGLE_CLIENT_SECRET=    #
GOOGLE_REDIRECT_URI=     # <APP_URL>/api/gmail/callback
APP_URL=                 # where the app is served from
SLACK_WEBHOOK_URL=       # in-kind win announcements (optional)
FIRECRAWL_CREDIT_USD=    # what one Firecrawl credit costs on your plan, so
                         # contact lookups count against the $20 cap. Unset
                         # means they are counted but not priced, and the run
                         # says so rather than under-reporting the total.
SESSION_SECRET=          # any long random string
APP_TEAM_PASSWORD=       # shared team login
```

Only the first three are required for a run to work. Without the `GOOGLE_*`
trio the composer still writes and copies outreach; only in-app sending is off.

The club mailbox is connected once, from **Settings → Club mailbox**, using the
shared Enactus Google account rather than anyone's personal one — the whole
point is that outreach outlives the executive who sent it. Its refresh token is
stored server-side and never reaches the browser. Apply `neon-setup.sql` to
your database once before the first start.

Access is a single shared team password rather than per-user accounts —
deliberate, for a five-person volunteer team with annual turnover, and the
obvious thing to replace first if the team grows. The display name is
free text, so it is settled at sign-in against the names the team has already
used: type `michael` and the board records `Michael`. Case and spacing only —
nothing assumes `Mike` is `Michael`, because a club with two Michaels is not
unusual and merging two volunteers' work is worse than two spellings of one.

## Checks

```bash
npm run check
```

`scripts/selfcheck.ts` asserts the pure logic — count parsing, filtering and
sorting, email linting, money parsing, scoreboard bucketing and the Slack
announcement wording — with no test framework and no database. Everything it covers is dependency-free by design, so
it runs in about a second.

```bash
npm run lint
npx tsc --noEmit
```

### Reading the runs back

```bash
node --experimental-strip-types scripts/run-report.ts
```

Every run writes down what it did -- the queries it ran, what discovery
returned, where the funnel lost candidates, what it cost -- and the leads and
the API spend both carry the run's id. That makes two questions answerable
that were not before: what a qualified lead costs, and which search query
found the lead that eventually replied. Read-only; runs from before the
run-log migration have no trace.

## Layout

```
src/app/(app)/     the four pages
src/app/api/       route handlers
src/lib/           the actual logic — agent pipeline, providers, pure helpers
src/lib/targeting  who the club targets: one file holding the prose the
                   prompts are built from and the patterns the code matches on
scripts/           selfcheck, score backtest, lead rescore, run report,
                   entity backfill
neon-setup.sql     schema (7 tables, all prefixed enactus_)
```

Anything in `src/lib/` that `selfcheck.ts` covers has no static imports, so it
can be run directly under `node --experimental-strip-types`. Constants and types
arrive as arguments instead.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 · Neon Postgres ·
deployed on Vercel.
