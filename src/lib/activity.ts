// Who was using the tool when something happened.
//
// One row per action: the signed-in person's display name, what they did, and
// which record it happened to. That is attribution, and it is all this is.
//
// ATTRIBUTION IS NOT ACCOUNTABILITY. Privacy law wants a single designated
// individual answerable for the whole database, permanently, whoever happens to
// be logged in. That designation is a separate open decision and is
// deliberately not encoded anywhere in this repository. Do not read a name in
// this log as the accountable person, and do not add a field that claims to
// name one.
//
// NO CREDENTIAL EVER ENTERS THIS TABLE. `detail` carries identifiers and short
// labels -- a lead id, a company name, which fields were edited -- and never a
// key, a token, a session cookie or the body of an email. `scrubDetail` below
// is the backstop that enforces it rather than trusting each call site to
// remember, and it is what holds `detail` to primitives at runtime rather than
// only in the type.

import { supabaseAdmin, ACTIVITY, hasServiceKey } from "./supabase";

export type ActivityAction =
  | "signed_in"
  | "agent_run"
  | "lead_created"
  | "lead_updated"
  | "lead_deleted"
  | "draft_generated"
  | "gmail_draft_created";

export type ActivitySubject = "session" | "search" | "lead" | "draft";

/** Only primitives, so no object can smuggle a nested secret past the scrub. */
export type ActivityDetail = Record<string, string | number | boolean | null>;

export interface ActivityEntry {
  /** The signed-in person's display name, from the session cookie. */
  actor: string;
  action: ActivityAction;
  subject: ActivitySubject;
  subjectId?: string | null;
  detail?: ActivityDetail;
}

export const REDACTED = "[redacted]";

// A key whose name says the value is a secret, is message content, or is
// somebody's personal detail. Matched loosely on purpose: a false positive
// costs one log field, a false negative writes a credential -- or a stranger's
// name and address -- into a table nobody thought to check.
//
// `subject_type` and `subject_id` are columns of their own and are unaffected;
// this only ever runs over the free-form `detail` map.
const UNSAFE_KEY =
  /(key|token|secret|password|passwd|credential|auth|bearer|cookie|session|signature|body|message|content|prompt|subject|email|recipient|address|phone|name)/i;

// A value that looks like a credential whatever it was called: provider keys,
// bearer tokens, JWTs, long opaque blobs.
const SECRET_VALUE = [
  /\bsk-[a-z0-9-]{8,}/i,
  /\bBearer\s+\S+/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\b(sb|sbp|eyJhbGciOi)[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{12,}/,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,
];

/** Long enough to be prose, short enough for a company name or an id. */
const MAX_VALUE_LENGTH = 120;

/**
 * Strips anything that could be a credential or a piece of message content.
 * Runs on every entry, including ones written by future call sites that never
 * read this file.
 */
export function scrubDetail(detail: ActivityDetail | undefined): ActivityDetail {
  const safe: ActivityDetail = {};
  for (const [key, value] of Object.entries(detail ?? {})) {
    if (UNSAFE_KEY.test(key)) {
      safe[key] = REDACTED;
      continue;
    }
    // The type says primitives; a call site handing this a parsed request body
    // is not bound by the type. Anything that is not genuinely a primitive is
    // redacted rather than written through, because a nested value is exactly
    // where a token or an email body would ride in unread.
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
      continue;
    }
    if (typeof value !== "string") {
      safe[key] = REDACTED;
      continue;
    }
    if (value.length > MAX_VALUE_LENGTH || SECRET_VALUE.some((p) => p.test(value))) {
      safe[key] = REDACTED;
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

export interface ActivityResult {
  /** True only when a row was actually written. */
  logged: boolean;
  error: string | null;
}

/**
 * Records one action. Never throws: attribution failing must not undo work the
 * human already did. It does not pretend either -- the caller gets back whether
 * the row was written, on the same rule `persistLead` follows, and says so
 * where it has somewhere to say it.
 */
export async function logActivity(entry: ActivityEntry): Promise<ActivityResult> {
  if (!hasServiceKey()) return { logged: false, error: null };
  try {
    const { error } = await supabaseAdmin.from(ACTIVITY).insert({
      actor_name: entry.actor,
      action: entry.action,
      subject_type: entry.subject,
      subject_id: entry.subjectId ?? null,
      detail: scrubDetail(entry.detail),
    });
    if (error) return { logged: false, error: error.message };
    return { logged: true, error: null };
  } catch (e) {
    return { logged: false, error: (e as Error).message };
  }
}
