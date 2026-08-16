// Post-checks on a finished outreach email.
//
// These live outside the route because a Next.js route file may only export its
// HTTP methods and config, and logic this fiddly with this many measured false
// positives has to be testable. See scripts/selfcheck.ts.
//
// No imports on purpose: selfcheck runs this file under
// `node --experimental-strip-types`, which cannot resolve extensionless
// specifiers, and the bundler tsconfig rejects the .ts extensions that would
// fix that. Every other selfcheck-tested lib here is self-contained for the
// same reason, so the constants arrive as arguments.

export const projectNames = (projects: string) =>
  [...projects.matchAll(/^- ([^:]+):/gm)].map((m) => m[1]);

const NUMBER = /\$?\d[\d,.]*%?/g;

// The greeting is a fact, so it is built here rather than asked for. Models
// write one anyway, so the model's is cut first, exactly like the sign-off.
// All ten sampled drafts opened with a legal entity ("Hi Coca-Cola Canada
// Bottling Ltd.,"), truncated differently each time.
export function greet(body: string, contact: string): string {
  const first = contact.trim().split(/\s+/)[0] || "there";
  return `Hi ${first},\n\n${body.replace(/^\s*(hi|hello|hey|dear)\b[^\n]*\n+/i, "").trimStart()}`;
}

/**
 * Re-check the finished body against the material the model was given. The STYLE
 * rules about numbers and invented claims are prompt-only and demonstrably do
 * not hold: ten sampled drafts shipped a "$10 million Impact GIC", "your Big
 * Idea Grant" and "collaborated with SFU Beedie students", none of which came
 * from a lead row.
 *
 * Warnings only: correcting a claim would mean inventing one, and Michael is
 * already in the loop before send. That makes a false positive expensive -- an
 * amber box that cries wolf gets ignored -- so each check below is narrower than
 * the obvious version, and selfcheck pins the cases that made it that way.
 *
 * `goal` is the system prompt the model was actually handed, so sales mode is
 * checked against the ventures blurb and sponsor mode against the org and
 * project blocks. Reading it off the prompt is what keeps the two from drifting.
 */
export function lint(
  body: string,
  opts: {
    facts: string;
    goal: string;
    connection: string | null | undefined;
    recentProjects: string[];
    projectNames: string[];
  }
): string[] {
  const w: string[] = [];
  const known = `${opts.facts}\n${opts.goal}`;

  // Compared as whole tokens, not substrings: `known.includes("3")` is true for
  // any facts mentioning 1936, which quietly excused every small number. The
  // trim matters because [\d,.]* swallows a sentence-final period or a clause
  // comma, so "since 1936." is not the token that was copied out of the facts.
  const numTok = (t: string) => t.replace(/^\$/, "").replace(/[.,]+$/, "");
  const knownNums = new Set((known.match(NUMBER) ?? []).map(numTok));
  for (const raw of body.match(NUMBER) ?? []) {
    if (!knownNums.has(numTok(raw))) w.push(`Number "${raw.replace(/[.,]+$/, "")}" is not in the facts.`);
  }

  // Only a claim about THIS COMPANY is a fabrication. Our own material says
  // "Second Savour is Burnaby-based, SFU-founded", and "our SFU students" is
  // ordinary self-reference: neither is second-person, so neither warns. The
  // sampled failure, "you have collaborated with SFU Beedie students", is.
  if (!opts.connection || opts.connection === "none") {
    for (const s of body.split(/(?<=[.!?])\s+/)) {
      const rest = s.replace(/Enactus SFU|Simon Fraser University/gi, "");
      // \balumn[ai]\b, not /alum/ -- the loose version fires on "recycled
      // aluminum", which is every packaging lead Alara gets pitched to.
      if (/\b(?:you|your|you're)\b/i.test(s) && /\bSFU\b|\bSimon Fraser\b|\bBeedie\b|\balumn[ai]\b|\balumnus\b/i.test(rest)) {
        w.push("Claims a link to SFU, but this lead has no connection on file.");
      }
    }
  }

  for (const m of body.matchAll(/\b(?:your|the)\s+((?:[A-Z][\w'-]+\s+){1,3}(?:Grant|Fund|Program|Policy|Initiative|Scholarship|Award|Strategy))\b/g)) {
    const named = m[1].trim();
    // "the Renovo Program" is one of ours, and `known` only ever carries "Renovo:".
    if (opts.projectNames.some((p) => named.startsWith(p))) continue;
    if (!known.includes(named)) w.push(`Names "${named}", which is not in the facts.`);
  }

  const used = opts.projectNames.find((p) => body.includes(p));
  if (used && opts.recentProjects.includes(used)) w.push(`The last few emails also pitched ${used}.`);

  // Two "3"s in one email produced the same string twice, and the client keys
  // the warning list by its text.
  return [...new Set(w)];
}
