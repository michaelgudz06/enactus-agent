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
mkdir -p "$cache"
ua='enactus-alumni-roster/1.0 (Enactus SFU past-executive reconstruction)'

# Every cached page records where it came from. build.ts reads this rather than
# reconstructing a URL from a filename, and drops any page missing from it, so a
# row's source_url is always the URL that was actually retrieved.
manifest="$cache/manifest.tsv"
failures="$cache/.failures"
: > "$manifest"
: > "$failures"

cdx() { # cdx <url-pattern> -> "timestamp status digest" rows
  curl -sS --max-time 120 --retry 4 --retry-delay 5 --retry-connrefused \
    "http://web.archive.org/cdx/search/cdx?url=$1&output=text&fl=timestamp,statuscode,digest" \
    || { echo "  ! CDX query failed for $1" >&2; echo "cdx:$1" >> "$failures"; }
}

grab() { # grab <local-name> <wayback-timestamp> <original-url>
  local out="$cache/$1" url="https://web.archive.org/web/$2id_/$3"
  if [ ! -s "$out" ]; then
    curl -sS --max-time 90 --retry 4 --retry-delay 5 --retry-connrefused -A "$ua" \
      "$url" -o "$out" 2>/dev/null
    sleep 1
  fi
  if [ -s "$out" ]; then
    printf '%s\t%s\n' "$1" "$url" >> "$manifest"
  else
    rm -f "$out"
    echo "  ! could not fetch $1" >&2
    echo "$url" >> "$failures"
  fi
}

archived() { # archived <prefix> <cdx-pattern> <original-url>
  echo "== $1"
  cdx "$2" | awk '$2==200 && !seen[$3]++ {print $1}' | while read -r ts; do
    grab "$1-$ts.html" "$ts" "$3"
  done
}

# --- the former WordPress site, enactussfu.com (2012-2019) ------------------
archived exec        'enactussfu.com/executives/'       'http://enactussfu.com/executives/'
archived pm          'enactussfu.com/program-managers/' 'http://enactussfu.com/program-managers/'
# the same page renamed in 2017; it is the only source for project leads 2017-2019
archived projectpm   'enactussfu.com/project-managers/' 'http://enactussfu.com/project-managers/'
archived alumni      'enactussfu.com/alumni/'           'http://enactussfu.com/alumni/'

# --- the Wix site, enactussfu.ca (2023) ------------------------------------
archived ourteam     'www.enactussfu.ca/our-team'       'https://www.enactussfu.ca/our-team'

# --- the Squarespace site, enactussfu.ca (2023-2024) -----------------------
archived theteam     'enactussfu.ca/the-team'           'https://enactussfu.ca/the-team'

# --- the current site, enactussfu.ca ---------------------------------------
archived team        'www.enactussfu.ca/team'           'https://www.enactussfu.ca/team'
archived competition 'www.enactussfu.ca/competition'    'https://www.enactussfu.ca/competition'

# --- "Community Spotlight" posts, which name alumni in their titles ---------
# This sweep needs the CDX `original` column to recover each post's own URL, so
# it does not go through cdx()/archived().
echo "== spotlight"
curl -sS --max-time 180 --retry 4 --retry-delay 5 --retry-connrefused \
  "http://web.archive.org/cdx/search/cdx?url=enactussfu.com*&output=text&fl=timestamp,original,statuscode&limit=20000" \
  | grep 'community-spotlight' \
  | grep -v 'wc-ajax\|/feed\|wp-json\|category/\|replytocom' \
  | awk '$3==200 && !seen[$2]++ {print $1, $2}' \
  | while read -r ts url; do
      slug="$(printf '%s' "$url" | grep -oE 'community-spotlight-[a-z0-9-]+')"
      [ -n "$slug" ] || continue
      grab "spotlight-$ts-$slug.html" "$ts" "$url"
    done

# --- the live site, for the roster the club publishes today -----------------
echo "== live"
for page in team competition; do
  out="$cache/live-$page.html"
  url="https://www.enactussfu.ca/$page"
  if curl -sS --max-time 60 --retry 4 --retry-connrefused -A "$ua" -L "$url" -o "$out" 2>/dev/null \
    && [ -s "$out" ]; then
    printf '%s\t%s\n' "live-$page.html" "$url" >> "$manifest"
  else
    rm -f "$out"
    echo "  ! could not fetch live-$page.html" >&2
    echo "$url" >> "$failures"
  fi
done

cached=$(grep -c . "$manifest")
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
