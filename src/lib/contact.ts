// Contact-detail verification.
//
// The model is allowed to *report* a contact address; only code decides whether
// that address is usable. An address that fails is kept on the record as
// unverified -- never presented as a contact, and never silently dropped along
// with the lead, because the company may still be worth pursuing.

import { promises as dns } from "node:dns";

export type EmailCheck =
  | { ok: true; email: string }
  | { ok: false; email: string; reason: "format" | "domain" };

/** Resolves true when a domain has a record that can accept mail. */
export type DomainResolver = (domain: string) => Promise<boolean>;

// Deliberately conservative: one @, no whitespace, a dotted TLD of 2+ letters.
// This is a plausibility gate, not RFC 5322.
const EMAIL_SHAPE = /^[^\s@,;:<>()[\]\\"]+@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * MX first, then A/AAAA: a domain with an address record but no MX still accepts
 * mail under RFC 5321's implicit-MX rule, so treating it as undeliverable would
 * reject real small-business addresses.
 */
export const dnsMailResolver: DomainResolver = async (domain) => {
  try {
    const mx = await dns.resolveMx(domain);
    if (mx.some((r) => r.exchange)) return true;
  } catch {
    // fall through to address records
  }
  try {
    if ((await dns.resolve4(domain)).length) return true;
  } catch {
    // fall through to IPv6
  }
  try {
    if ((await dns.resolve6(domain)).length) return true;
  } catch {
    // no usable record
  }
  return false;
};

function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

/**
 * Builds a verifier for one agent run. Domains are looked up at most once per
 * run and only after the cheap format gate has passed, which keeps the whole
 * check to a handful of DNS queries per run.
 */
export function createContactEmailVerifier(
  opts: { resolve?: DomainResolver; timeoutMs?: number } = {}
): (email: unknown) => Promise<EmailCheck> {
  const resolve = opts.resolve ?? dnsMailResolver;
  const timeoutMs = opts.timeoutMs ?? 2500;
  const seen = new Map<string, Promise<boolean>>();

  return async function verify(email: unknown): Promise<EmailCheck> {
    if (typeof email !== "string" || !email.trim()) {
      return { ok: false, email: typeof email === "string" ? email : "", reason: "format" };
    }
    const raw = email.trim();
    const at = raw.lastIndexOf("@");
    const normalized = at === -1 ? raw : `${raw.slice(0, at)}@${raw.slice(at + 1).toLowerCase()}`;
    if (!EMAIL_SHAPE.test(normalized)) return { ok: false, email, reason: "format" };

    const domain = normalized.slice(normalized.lastIndexOf("@") + 1);
    let pending = seen.get(domain);
    if (!pending) {
      pending = withTimeout(resolve(domain), timeoutMs, false);
      seen.set(domain, pending);
    }

    return (await pending) ? { ok: true, email: normalized } : { ok: false, email: normalized, reason: "domain" };
  };
}
