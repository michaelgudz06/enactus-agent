# Database backups

Point-in-time exports of the live Supabase tables, one JSON file per table per date.

## Why these exist

On 2026-08-06 both Supabase projects referenced by this app stopped resolving
(NXDOMAIN) and the database was unreachable. It was restored, but the incident
showed the lead data existed in exactly one place and was not recoverable from
this repository.

The code has always been safe in git. The data was not. These files close that gap.

## Contents

| File | Rows |
|---|---|
| `enactus_leads_2026-08-06.json` | 12 |
| `enactus_searches_2026-08-06.json` | 10 |
| `enactus_email_drafts_2026-08-06.json` | 5 |

Taken immediately before the Kanban board was cleared, so this is the full record
of everything the tool produced up to that point.

## Privacy

These files contain business contact information for named individuals at real
companies - names, titles, and work email addresses.

**This repository is private and must stay private.** Making it public would
publish that personal information.

Under Canadian privacy law the business-contact exemption applies only while the
information is collected, used, and disclosed *solely* for communicating with the
person about their employment or profession. Keep it to that purpose. If someone
asks to be removed, remove them here as well as from the live database.

## Regenerating

Any export must read credentials from `.env.local` and must never print, log, or
commit a key. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are the variables used.
