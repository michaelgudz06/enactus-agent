// One person, spelled one way.
//
// Access is a shared team password and the display name is free text -- a
// deliberate choice for a five-person volunteer team, and the README says so.
// The cost of it is that the name is whatever was typed, and the live board
// already held "michael" and "Michael" as two different people.
//
// The scoreboard was repaired for that by grouping case-insensitively, which
// fixes the totals and not the cause: the board's owner filter, the "created
// by" line on a card and the activity log all still show whichever spelling
// happened to be typed that day, and a third variant arrives every time
// somebody signs in on a new phone.
//
// So the name is canonicalised once, at sign-in, against the names the team has
// already used. Server-side and AFTER the password check, deliberately: the
// login page reasons explicitly about not handing out the team's names to
// anyone who can load it, and that reasoning is right.
//
// DELIBERATELY EXACT, case aside. Nothing here guesses that "Mike" is
// "Michael" or that "Michael G" is the same person as "Michael" -- a club with
// two Michaels is not unusual, and silently merging two volunteers' work is a
// worse failure than two spellings of one. Only differences that cannot mean
// two different people are collapsed.
//
// No imports, so scripts/selfcheck.ts can load it under
// `node --experimental-strip-types`.

/** The comparison form: case, surrounding space and internal runs of space. */
export function nameKey(name: string | null | undefined): string {
  return (name ?? "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The spelling this person is already known by, or a tidied version of what
 * they typed.
 *
 * `known` is the names the team has used before, most recent first; the first
 * match wins, so a name that has been re-spelled settles on the newest form
 * rather than the oldest.
 */
export function canonicalName(input: string, known: string[] = []): string {
  const tidy = (input ?? "").normalize("NFC").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!tidy) return "";
  const key = nameKey(tidy);
  for (const candidate of known) {
    if (nameKey(candidate) === key) return candidate.normalize("NFC").replace(/\s+/g, " ").trim();
  }
  return tidy;
}
