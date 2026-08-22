#!/usr/bin/env bash
#
# Populate the snapshot cache the roster is built from.
#
#   scripts/alumni-roster/fetch-snapshots.sh [cache-dir]
#
# Default cache dir: .cache/alumni-roster (gitignored — the raw pages carry the
# contact detail this repository must not store; only name/role/years reach
# config/alumni/past-executives.csv).
#
# Reads only pages the club itself published. Never fetches LinkedIn.
#
# The `id_` suffix on a Wayback URL returns the original HTML without the
# archive's toolbar injection. One snapshot per unique content digest is enough:
# the CDX `digest` column identifies captures whose bodies are byte-identical.
#
# A page that will not download costs that page and nothing else. The run
# continues, the failures are listed at the end, and re-running fills the gaps —
# this is a couple of hundred requests against a service that rate-limits, so
# aborting the whole fetch on one blip would be the wrong trade.
set -uo pipefail

cache="${1:-.cache/alumni-roster}"

# Lexical, so it works on a directory that does not exist yet: "$PWD/../elsewhere"
# is not inside "$PWD", but the string it spells starts with it, and comparing
# the strings refused a legitimate cache outside the repository with a diagnosis
# that was simply wrong.
normalise_path() { # normalise_path <path> -> absolute, no "." or ".." segments
  local raw="$1" out="" segment
  case "$raw" in /*) ;; *) raw="$PWD/$raw" ;; esac
  while [ -n "$raw" ]; do
    segment="${raw%%/*}"
    case "$raw" in */*) raw="${raw#*/}" ;; *) raw="" ;; esac
    case "$segment" in
      "" | .) ;;
      ..) out="${out%/*}" ;;
      *) out="$out/$segment" ;;
    esac
  done
  printf '%s' "${out:-/}"
}

# The pages this writes carry the role addresses, phone numbers and employers the
# shipped file exists to leave behind, so a cache in a repository that git does
# not ignore is one `git add -A` away from committing them — and personal data in
# a commit is not undone by a later fix. git decides, not a second copy of the
# ignore rules here, and the answer is decided before a page is written.
#
# git is asked about the cache path, not about wherever this was started from: a
# run launched outside any repository asked a question with no answer and took
# silence for permission, so it wrote raw pages into whatever repository it was
# pointed at. The deepest existing ancestor stands in for a directory this run
# has not created yet, and any repository counts — committing someone's phone
# number to a different one is the same commit.
cache_abs="$(normalise_path "$cache")"
probe="$cache_abs"
while [ ! -d "$probe" ]; do
  parent="$(dirname "$probe")"
  [ "$parent" = "$probe" ] && break
  probe="$parent"
done
if git -C "$probe" rev-parse --show-toplevel >/dev/null 2>&1 \
  && ! git -C "$probe" check-ignore -q "$cache_abs"; then
  echo "refusing to cache archived pages in $cache_abs" >&2
  echo "That path is inside a git repository that does not ignore it, so the raw" >&2
  echo "pages — role email addresses, phone numbers, employers — would be one" >&2
  echo "'git add -A' away from the history of a repository holding real people's" >&2
  echo "records. Use the default .cache/alumni-roster, add the path to .gitignore," >&2
  echo "or point the cache outside the repository." >&2
  exit 1
fi

mkdir -p "$cache"
ua='enactus-alumni-roster/1.0 (Enactus SFU past-executive reconstruction)'

# The one declaration of what this roster is built from. build.ts reads the same
# file and checks every source it names, so adding a source is one row here.
registry="$(dirname "$0")/sources.tsv"
if [ ! -r "$registry" ]; then
  echo "no readable $registry — there is nothing to fetch without it." >&2
  exit 1
fi

# Every cached page records where it came from. build.ts reads this rather than
# reconstructing a URL from a filename, and drops any page missing from it, so a
# row's source_url is always the URL that was actually retrieved.
#
# The manifest accumulates across runs rather than being rebuilt from scratch: a
# re-run whose CDX query is rate-limited never re-enumerates that source, and
# starting from an empty manifest would strip the provenance from pages already
# in the cache — which build.ts would then drop, shrinking the roster silently.
manifest="$cache/manifest.tsv"
failures="$cache/.failures"
touch "$manifest"
: > "$failures"

# Matched on name AND url: a live page is re-downloaded every run, so if its URL
# in the registry changed, the bytes now on disk came from the new one. Recording
# the name as already known would leave the manifest citing a page these bytes
# never came from, and build.ts would stamp that URL on every row it produced.
# The later line wins when build.ts reads the manifest, so appending is enough.
note_source() { # note_source <local-name> <url>
  awk -F'\t' -v name="$1" -v url="$2" '$1 == name && $2 == url { hit = 1 } END { exit !hit }' \
    "$manifest" || printf '%s\t%s\n' "$1" "$2" >> "$manifest"
}

# Whether the manifest already knows where a cached file came from, whatever URL
# that was. The other half of the same rule: a page on disk was retrieved once,
# from one URL, and only that run knew which.
recorded() { # recorded <local-name>
  awk -F'\t' -v name="$1" '$1 == name { hit = 1 } END { exit !hit }' "$manifest"
}

# -f on every request: without it curl exits 0 on a 404, a 429 or a 503 and the
# error page is written to the cache as if it were a snapshot, where it is never
# re-fetched and parses to no roster at all. An error response has to leave no
# file behind and land in $failures, the same as a connection that never opened.
cdx() { # cdx <url-pattern> -> "timestamp status digest" rows
  curl -fsS --max-time 120 --retry 4 --retry-delay 5 --retry-connrefused \
    "http://web.archive.org/cdx/search/cdx?url=$1&output=text&fl=timestamp,statuscode,digest" \
    || { echo "  ! CDX query failed for $1" >&2; echo "cdx:$1" >> "$failures"; }
}

# A cached page is left exactly as it is, provenance included. Re-stamping it
# with the URL this run's registry row spells would claim a retrieval that never
# happened: edit a row and every page already on disk silently changes where it
# came from, without one byte being re-downloaded. Only a request that actually
# returned bytes may say where they came from — the same rule that makes live()
# match on name AND url, at the other end of the same problem.
#
# Cached but unrecorded is the exception, and it is fetched again rather than
# stamped with a guess: build.ts drops such a page and says to re-run this
# script, so re-running has to genuinely record it.
#
# That re-fetch downloads beside the page and replaces it only once bytes
# actually arrived. An archived capture is not re-creatable — the archive may
# not serve it again — so a rate-limited retry that had first deleted the file
# would destroy the only copy of the evidence a real person's row cites. A
# request that returns nothing leaves the cached bytes exactly as they were and
# still lands in $failures, so re-running fills the gap.
grab() { # grab <local-name> <wayback-timestamp> <original-url>
  local out="$cache/$1" part="$cache/$1.part" url="https://web.archive.org/web/$2id_/$3"
  if [ -s "$out" ] && recorded "$1"; then
    return 0
  fi

  rm -f "$part"
  curl -fsS --max-time 90 --retry 4 --retry-delay 5 --retry-connrefused -A "$ua" \
    "$url" -o "$part" 2>/dev/null
  sleep 1

  if [ -s "$part" ]; then
    mv -f "$part" "$out"
    note_source "$1" "$url"
  else
    rm -f "$part"
    echo "  ! could not fetch $1" >&2
    echo "$url" >> "$failures"
  fi
}

archived() { # archived <prefix> <cdx-pattern> <original-url>
  cdx "$2" | awk '$2==200 && !seen[$3]++ {print $1}' | while read -r ts; do
    grab "$1-$ts.html" "$ts" "$3"
  done
}

# The sweep needs the CDX `original` column to recover each post's own URL, so it
# does not go through cdx()/archived(). The index goes to a file first, so a
# rate-limited response is a failed query rather than an empty result set piped
# into grep.
spotlight() { # spotlight <prefix> <cdx-pattern> <post-filter>
  local index="$cache/.$1-cdx"
  if curl -fsS --max-time 180 --retry 4 --retry-delay 5 --retry-connrefused \
    "http://web.archive.org/cdx/search/cdx?url=$2&output=text&fl=timestamp,original,statuscode&limit=20000" \
    -o "$index"; then
    grep -F "$3" "$index" \
      | grep -v 'wc-ajax\|/feed\|wp-json\|category/\|replytocom' \
      | awk '$3==200 && !seen[$2]++ {print $1, $2}' \
      | while read -r ts url; do
          slug="$(printf '%s' "$url" | grep -oE "$3-[a-z0-9-]+")"
          [ -n "$slug" ] || continue
          grab "$1-$ts-$slug.html" "$ts" "$url"
        done
  else
    echo "  ! CDX query failed for the $1 sweep" >&2
    echo "cdx:$2 ($1)" >> "$failures"
  fi
  rm -f "$index"
}

live() { # live <prefix> <url>
  local out="$cache/$1.html"
  if curl -fsS --max-time 60 --retry 4 --retry-connrefused -A "$ua" -L "$2" -o "$out" 2>/dev/null \
    && [ -s "$out" ]; then
    note_source "$1.html" "$2"
  else
    rm -f "$out"
    echo "  ! could not fetch $1.html" >&2
    echo "$2" >> "$failures"
  fi
}

bad_row() { # bad_row <line-number> <complaint>
  echo "  ! $registry line $1: $2" >&2
  echo "registry:line $1" >> "$failures"
}

# Every source comes from the registry, and nowhere else. A source this script
# does not fetch is a source build.ts reports as yielding nothing, because both
# read this one file — a list kept here as well would be a list that can drift.
#
# The row checks below are the ones parseSourceRegistry makes, so a registry one
# reader rejects is a registry the other rejects too. A row with a stray leading
# tab is the case worth the trouble: it once read as a blank line, so the source
# was never fetched and this script still reported success.
# parseSourceRegistry trims every field before it reads it, so this does too. A
# CRLF checkout otherwise leaves a carriage return on the last column of every
# row, and one whitespace problem is reported here as a malformed filter and
# there as a malformed registry — two unrelated-looking errors for one cause.
trim() { # trim <value>
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  printf '%s' "${value%"${value##*[![:space:]]}"}"
}

line=0
seen_keys=""
seen_prefixes=""
seen_prefix_words=""
while IFS= read -r row <&3 || [ -n "${row:-}" ]; do
  line=$((line + 1))
  trimmed="$(trim "$row")"
  case "$trimmed" in '#'*) continue ;; esac
  [ -z "$trimmed" ] && continue

  # Counted off the raw line, not off `read`: tab is IFS whitespace, so a
  # trailing empty column would otherwise vanish and a seven-column row would
  # pass here and be rejected by build.ts hours of downloads later.
  tabs="${row//[!$'\t']/}"
  if [ "${#tabs}" -ne 5 ]; then
    bad_row "$line" "expected 6 tab-separated fields, found $(( ${#tabs} + 1 ))"
    continue
  fi
  IFS=$'\t' read -r key kind prefix pattern url filter <<< "$row"
  key="$(trim "$key")"
  kind="$(trim "$kind")"
  prefix="$(trim "$prefix")"
  pattern="$(trim "$pattern")"
  url="$(trim "$url")"
  filter="$(trim "$filter")"

  if [ -z "$key" ] || [ -z "$kind" ] || [ -z "$prefix" ] \
    || [ -z "$pattern" ] || [ -z "$url" ] || [ -z "$filter" ]; then
    bad_row "$line" "every column needs a value; write '-' where a kind does not use one"
    continue
  fi
  # The prefix names files on disk and is claimed with a startsWith, so it is
  # checked like one rather than only for emptiness.
  if ! printf '%s' "$prefix" | grep -qE '^[A-Za-z0-9][A-Za-z0-9-]*$'; then
    bad_row "$line" "a cache prefix is letters, digits and dashes, not '$prefix'"
    continue
  fi
  if [ "$kind" = spotlight ] && ! printf '%s' "$filter" | grep -qE '^[A-Za-z0-9][A-Za-z0-9-]*$'; then
    bad_row "$line" "a spotlight source needs a post filter of letters, digits and dashes, not '$filter'"
    continue
  fi
  case "$seen_keys" in *"|$key|"*) bad_row "$line" "duplicate source key '$key'"; continue ;; esac
  case "$seen_prefixes" in *"|$prefix|"*) bad_row "$line" "duplicate cache prefix '$prefix'"; continue ;; esac
  # A prefix that is another prefix plus a dash claims that source's archived
  # pages as well as its own: a row prefixed `live` would take `live-team.html`.
  ambiguous=""
  for seen in $seen_prefix_words; do
    case "$prefix" in "$seen"-*) ambiguous="$seen" ;; esac
    case "$seen" in "$prefix"-*) ambiguous="$seen" ;; esac
  done
  if [ -n "$ambiguous" ]; then
    bad_row "$line" "cache prefix '$prefix' and '$ambiguous' would claim each other's pages"
    continue
  fi
  seen_keys="$seen_keys|$key|"
  seen_prefixes="$seen_prefixes|$prefix|"
  seen_prefix_words="$seen_prefix_words $prefix"

  echo "== $key"
  case "$kind" in
    archived)  archived  "$prefix" "$pattern" "$url" ;;
    spotlight) spotlight "$prefix" "$pattern" "$filter" ;;
    live)      live      "$prefix" "$url" ;;
    *)         bad_row "$line" "kind '$kind' is not one of archived, spotlight, live" ;;
  esac
done 3< "$registry"

cached=$(awk -F'\t' '$1 != "" && !seen[$1]++ { n += 1 } END { print n + 0 }' "$manifest")
missed=$(grep -c . "$failures")
echo "cached $cached pages in $cache"
if [ "$missed" -gt 0 ]; then
  echo
  echo "$missed source(s) could not be fetched. The roster built from this cache is"
  echo "missing whatever they held. Re-run to fill the gaps — cached pages are skipped:"
  sed 's/^/  /' "$failures"
  exit 1
fi
rm -f "$failures"
