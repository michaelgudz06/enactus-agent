// Contact-detail verification.
//
// The model is allowed to *report* a contact address or a company website; only
// code decides whether either is usable. Anything that fails is kept on the
// record as unverified -- never presented as a verified detail, and never
// silently dropped along with the lead, because the company may still be worth
// pursuing.
//
// Emails and websites share one resolver so a run looks each domain up at most
// once no matter how many fields point at it.

import { promises as dns } from "node:dns";

// "domain" is a conclusion the code reached: the resolver answered, and there is
// nothing there. "unverified" is the absence of a conclusion: the lookup never
// completed. They are kept apart because the second must never be reported as
// the first -- a slow resolver is not evidence that a real business is fake.
export type EmailCheck =
  | { ok: true; email: string }
  | { ok: false; email: string; reason: "format" | "domain" | "unverified" };

export type WebsiteCheck =
  | { ok: true; url: string }
  | { ok: false; url: string; reason: "format" | "aggregator" | "domain" | "unverified" };

/**
 * Resolves true when a domain has a record that can accept mail, false when the
 * lookup completed and there is none, and REJECTS when the lookup could not be
 * completed at all (a soft DNS failure). A rejection is not a negative answer.
 */
export type DomainResolver = (domain: string) => Promise<boolean>;

type DomainVerdict = "usable" | "absent" | "unverified";

// Deliberately conservative: one @, no whitespace, a dotted TLD of 2+ letters.
// This is a plausibility gate, not RFC 5322.
const EMAIL_SHAPE = /^[^\s@,;:<>()[\]\\"]+@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const DOMAIN_SHAPE = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

// Platforms that host pages *about* a company rather than the company's own
// site. A page on one of these is legitimate evidence, but its hostname belongs
// to the platform and is never the company's website.
const AGGREGATOR_HOST =
  /(^|\.)(linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|threads\.net|tiktok\.com|youtube\.com|medium\.com|substack\.com|crunchbase\.com|yelp\.[a-z.]+|tripadvisor\.[a-z.]+|bbb\.org|eventbrite\.[a-z.]+)$/i;

export function isAggregatorHost(host: string): boolean {
  return AGGREGATOR_HOST.test(host);
}

// A resolver failure that says nothing about the domain: the server was busy,
// unreachable, or gave up. NXDOMAIN and ENODATA are absent from this list on
// purpose -- those are real answers.
const SOFT_DNS_FAILURE = new Set([
  "EAI_AGAIN",
  "ESERVFAIL",
  "ETIMEOUT",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "EREFUSED",
  "ECANCELLED",
  "ELOOP",
  "ENOMEM",
]);

function softFailure(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && SOFT_DNS_FAILURE.has(code);
}

/**
 * MX first, then A/AAAA: a domain with an address record but no MX still accepts
 * mail under RFC 5321's implicit-MX rule, so treating it as undeliverable would
 * reject real small-business addresses. Returns false only when every lookup
 * came back with a real answer and none of them found a record; if any lookup
 * failed softly, that is rethrown so the caller records "not checked" rather
 * than "does not exist".
 */
export const dnsMailResolver: DomainResolver = async (domain) => {
  let soft: unknown = null;
  try {
    const mx = await dns.resolveMx(domain);
    if (mx.some((r) => r.exchange)) return true;
  } catch (e) {
    if (softFailure(e)) soft = e;
  }
  try {
    if ((await dns.resolve4(domain)).length) return true;
  } catch (e) {
    if (soft === null && softFailure(e)) soft = e;
  }
  try {
    if ((await dns.resolve6(domain)).length) return true;
  } catch (e) {
    if (soft === null && softFailure(e)) soft = e;
  }
  if (soft !== null) throw soft;
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

// A hedged or narrated answer ("https://example.ca/ (example website)") is not a
// web address; a real one never carries whitespace. Everything else is parsed
// with the URL parser rather than guessed at.
function parseWebsite(raw: string): { url: string; domain: string } | null {
  if (/\s/.test(raw)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const domain = url.hostname.replace(/^www\./i, "").toLowerCase();
  if (!DOMAIN_SHAPE.test(domain)) return null;
  return { url: url.toString(), domain };
}

export interface Verifiers {
  /** An address the model reported. */
  email(value: unknown): Promise<EmailCheck>;
  /** A company website the model reported. */
  website(value: unknown): Promise<WebsiteCheck>;
}

/**
 * Builds the verifiers for one agent run. Domains are looked up at most once per
 * run and only after the cheap format gate has passed, which keeps the whole
 * check to a handful of DNS queries per run.
 */
export function createVerifiers(opts: { resolve?: DomainResolver; timeoutMs?: number } = {}): Verifiers {
  const resolve = opts.resolve ?? dnsMailResolver;
  const timeoutMs = opts.timeoutMs ?? 2500;
  const seen = new Map<string, Promise<DomainVerdict>>();

  const resolves = (domain: string): Promise<DomainVerdict> => {
    let pending = seen.get(domain);
    if (!pending) {
      pending = withTimeout<DomainVerdict>(
        resolve(domain).then(
          (found) => (found ? "usable" : "absent"),
          () => "unverified"
        ),
        timeoutMs,
        "unverified"
      );
      seen.set(domain, pending);
    }
    return pending;
  };

  return {
    async email(value: unknown): Promise<EmailCheck> {
      if (typeof value !== "string" || !value.trim()) {
        return { ok: false, email: typeof value === "string" ? value : "", reason: "format" };
      }
      const raw = value.trim();
      const at = raw.lastIndexOf("@");
      const normalized = at === -1 ? raw : `${raw.slice(0, at)}@${raw.slice(at + 1).toLowerCase()}`;
      if (!EMAIL_SHAPE.test(normalized)) return { ok: false, email: value, reason: "format" };

      const domain = normalized.slice(normalized.lastIndexOf("@") + 1);
      const verdict = await resolves(domain);
      if (verdict === "usable") return { ok: true, email: normalized };
      return { ok: false, email: normalized, reason: verdict === "absent" ? "domain" : "unverified" };
    },

    async website(value: unknown): Promise<WebsiteCheck> {
      if (typeof value !== "string" || !value.trim()) {
        return { ok: false, url: typeof value === "string" ? value : "", reason: "format" };
      }
      const raw = value.trim();
      const parsed = parseWebsite(raw);
      if (!parsed) return { ok: false, url: raw, reason: "format" };
      if (isAggregatorHost(parsed.domain)) return { ok: false, url: raw, reason: "aggregator" };
      const verdict = await resolves(parsed.domain);
      if (verdict === "usable") return { ok: true, url: parsed.url };
      return { ok: false, url: raw, reason: verdict === "absent" ? "domain" : "unverified" };
    },
  };
}
