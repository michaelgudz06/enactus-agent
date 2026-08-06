// The one mechanism for reading what a model returned.
//
// A validation failure costs the smallest thing that actually failed, and
// nothing more. A field that does not match its own schema is read anyway when
// it has exactly one possible reading, and otherwise removed so the caller's
// default applies. Either way the slip is reported rather than swallowed,
// because a silent repair teaches nobody that the model is misbehaving.
//
// Every level that reads model output shares this: the search plan, each lead,
// and the outreach draft. A second, parallel mechanism is how the same failure
// shape reappeared one level higher three times over -- keep it single.

import { validateAgainstSchema } from "./llm";

export interface ValueDefect {
  /** What carries the defect: a company, a positional label, or the plan. */
  subject: string;
  field: string;
  detail: string;
  /**
   * What the defect cost: the value was read anyway ("coerced"), the field was
   * left at its default ("ignored"), or the whole record was unusable ("dropped").
   */
  action: "coerced" | "ignored" | "dropped";
}

export function describeValue(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

export function expectedTypes(schema: Record<string, unknown>): string {
  const declared = schema.type;
  return Array.isArray(declared) ? (declared as string[]).join(" or ") : String(declared);
}

function conformsTo(schema: Record<string, unknown> | undefined, value: unknown): boolean {
  if (!schema) return true;
  try {
    validateAgainstSchema(value, schema);
    return true;
  } catch {
    return false;
  }
}

/**
 * A value the model sent in the wrong form but with only one possible reading.
 * `"88"` for a number is a slip, not an ambiguity, so it is read; `"high"` is
 * open to interpretation, so it is not guessed at. Returns null when there is no
 * single reading, which leaves the field at its default.
 */
export function recoverValue(schema: Record<string, unknown>, value: unknown): { value: unknown } | null {
  const declared = schema.type;
  const allowed = Array.isArray(declared) ? (declared as string[]) : [String(declared)];

  if (allowed.includes("number") && typeof value === "string") {
    const trimmed = value.trim();
    const asNumber = Number(trimmed);
    if (trimmed && Number.isFinite(asNumber)) return { value: asNumber };
  }

  // Only the two literals. "yes" or "1" would be a guess, and whether to stop
  // and ask the user is not a guess worth making.
  if (allowed.includes("boolean") && typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "true") return { value: true };
    if (trimmed === "false") return { value: false };
  }

  if (allowed.includes("array")) {
    const items = schema.items as Record<string, unknown> | undefined;
    // A lone value where a list was asked for reads as a list of one.
    if (!Array.isArray(value) && value != null && conformsTo(items, value)) return { value: [value] };
    // A list whose entries are not all usable: the usable ones are still usable,
    // and one bad entry may not cost the entries beside it.
    if (Array.isArray(value)) {
      const kept = value.filter((entry) => conformsTo(items, entry));
      if (kept.length) return { value: kept };
    }
  }

  // The same reading mirrored: a list of one where a lone value was asked for is
  // that one value. A longer list is a choice between entries, which is not a
  // single reading, and an empty one carries nothing to read.
  if (!allowed.includes("array") && Array.isArray(value) && value.length === 1 && conformsTo(schema, value[0])) {
    return { value: value[0] };
  }

  return null;
}

const OBJECT_ENVELOPE: Record<string, unknown> = { type: "object" };

/**
 * Reads the object a payload is carrying, for the levels whose payload is a
 * single record: the search plan and the outreach draft. (The leads response is
 * a list, and normalises the mirror of this at its own boundary.)
 *
 * A copy is returned so the caller's field review can work in place. A payload
 * with no single object in it -- a string, a number, an empty list, a list of
 * several -- has nothing to read, and returns null so the caller can stop.
 */
export function readEnvelope(
  value: unknown,
  subject: string,
  carrier: string,
  defects: ValueDefect[]
): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  const recovered = recoverValue(OBJECT_ENVELOPE, value);
  if (!recovered) return null;
  defects.push({
    subject,
    field: carrier,
    detail: `read ${describeValue(value)} as the ${carrier} it contains`,
    action: "coerced",
  });
  return { ...(recovered.value as Record<string, unknown>) };
}

/**
 * Checks each present field against its own schema, in place.
 *
 * One bad field costs that field and nothing else: it is recovered when it has a
 * single reading, and otherwise deleted so the caller's normalisation supplies
 * the default. Absent fields are left alone -- a field the model chose not to
 * fill is not a defect. Every change is appended to `defects`.
 */
export function reviewFields(
  subject: string,
  raw: Record<string, unknown>,
  properties: Record<string, Record<string, unknown>>,
  defects: ValueDefect[]
): void {
  for (const [field, schema] of Object.entries(properties)) {
    if (raw[field] === undefined) continue;
    try {
      validateAgainstSchema(raw[field], schema, field);
    } catch {
      const recovered = recoverValue(schema, raw[field]);
      if (recovered) {
        defects.push({
          subject,
          field,
          detail: `read ${field} ${describeValue(raw[field])} as ${describeValue(recovered.value)}`,
          action: "coerced",
        });
        raw[field] = recovered.value;
      } else {
        defects.push({
          subject,
          field,
          detail: `expected ${expectedTypes(schema)}, got ${describeValue(raw[field])}`,
          action: "ignored",
        });
        delete raw[field];
      }
    }
  }
}

/** `carrier` names what survived: the lead, the plan, the draft. */
export function defectMessage(defect: ValueDefect, carrier: string): string {
  switch (defect.action) {
    case "dropped":
      return `Dropped ${defect.subject}: ${defect.detail}.`;
    case "coerced":
      return `${defect.subject}: ${defect.detail}. The model sent the wrong type for it.`;
    default:
      return `${defect.subject}: ignoring ${defect.field} — ${defect.detail}. The rest of the ${carrier} was kept.`;
  }
}
