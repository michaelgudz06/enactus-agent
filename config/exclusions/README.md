# Maintained exclusion lists

These CSVs are **policy, not code**. They are the part of the qualification layer a human
curates rather than the part code derives. A new exec in September must be able to read them,
diff them in a pull request, and change them without a programmer.

Source of truth for every rule and every seed row below:
`enactus-disqualifiers/report.md` §7 (research date **2026-08-06**).

## Owner

**The role of VP / Director of External Relations** — a role, never a person, because the club
turns its executive over completely every year. For 2026-27 that is Adrian Lai /
Nikita Venkatachellum, Co-Directors of External.

## Common columns

| Column | Meaning |
|---|---|
| `kind` | `domain` or `name`. A `domain` row matches `registrable_domain`; a `name` row matches `normalized_name`. |
| `value` | The domain (lowercase, registrable form, no `www.`) or the **normalized** name (casefolded, punctuation/accents stripped, legal suffixes removed). |
| `reason` | Why this row exists. Shown to a human in the Rejected view. |
| `added_by` | Who added it. `enactus-disqualifiers/report.md §7.x` for seed rows. |
| `added_at` | ISO date. |
| `source_url` | The page that justifies the row, so a future maintainer can re-verify it. |

Rows whose `value` is empty are **name-only entries that the report could not verify a domain
for**. They are deliberately blank rather than guessed — see the two live traps in
`report.md` §0.4 (`rbcfoundation.com` is Richard Bland College Foundation; `pcfinancial.com` is
parked on Afternic). Do not fill a blank in from memory; verify it first.

## The lists

| File | Report § | Used by | Cadence |
|---|---|---|---|
| `national-partners.csv` | §7.1 | K-ORG-01 → CHANNEL `enactus_canada` | Every September and every May |
| `national-flag.csv` | §7.2 | `human_review` only — never a kill | With §7.1 |
| `student-orgs.csv` | §7.3 | K-ORG-02 → TERMINAL | Annually each September |
| `edu-domains.csv` | §7.4 | K-ORG-02 / K-ORG-06 → TERMINAL | Rarely |
| `paid-membership.csv` | §7.5 | K-ORG-03a → TERMINAL | Quarterly, fed by the K-ORG-03c review queue |
| `gov-domains.csv` | §7.6 | K-ORG-04 → CHANNEL `grants_pipeline` | Rarely |
| `self.csv` | §7.7 | K-ORG-06 → TERMINAL | When a project launches |
| `never-kill-domains.csv` | §7.7 | **Overrides every §3 predicate except L-01** | When a partner is signed |
| `metro-vancouver.csv` | §7.8 | K-GEO-03 | Rarely |
| `sector-policy.csv` | §7.9 | K-REP-01 / K-REP-02 / P-13 | On demand, one human answer per row |
| `disposable-domains.csv` | §7.10 | D-06 → TERMINAL | Vendored, refreshed quarterly |
| `free-mail-providers.csv` | §3.5 D-07 | D-07 exemption | Rarely |
| `parking-nameservers.csv` | §3.5 D-02 | D-02 → TERMINAL | Rarely |
| `current-and-past-sponsors.csv` | §7.11 | K-REL-03, renewals, `never-kill` | Each September |

## Regenerating `student-orgs.csv`

```sh
curl -sL https://go.sfss.ca/clubs/list   # parse /clubs/<id> anchors — 154 rows on 2026-08-06
```

## Regenerating `disposable-domains.csv`

Vendor the file from
[`disposable-email-domains/disposable-email-domains`](https://github.com/disposable-email-domains/disposable-email-domains)
**at a pinned commit**. Do not fetch it at runtime: a build that silently changes its kill
behaviour because an upstream list moved is unauditable, and under CASL s.33(1) the club must be
able to reconstruct why a given decision was made.

The file shipped here is a **small seed subset**, not the vendored upstream list. It is enough to
make D-06 real and testable; it is not enough to be comprehensive.

## The rule that governs every list

A row here can only ever cause a **kill**, a **channel change** or a **penalty** on a *positive*
observation. Missing data is never a kill (`report.md` §2.3). A wrongly killed account is
invisible forever; a wrongly penalised one still surfaces.
