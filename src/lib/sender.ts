// Who the outreach is from.
//
// Drafts are written to be sent from an SFU inbox: the captain's ruling, and it
// is what gives a cold email to a Lower Mainland business the institutional
// weight the ICP is built around. The agent still never sends. A human presses
// send, from that inbox.
//
// The address is code's to decide, not the model's, so it is never asked for
// and never accepted from model output. It comes from `OUTREACH_FROM_EMAIL`,
// and a value that is not an @sfu.ca address is REJECTED rather than used: the
// whole point of the ruling is the domain, so quietly signing a draft from a
// gmail.com address would defeat it while looking fine.
//
// With nothing configured the draft still gets written -- a guard that stops a
// student drafting because an env var is missing is worse than no guard -- but
// it is signed with an obvious placeholder that nobody can mistake for a real
// address, and the reason is reported alongside the draft.

import { isEmailShape } from "./contact";
import { Mode } from "./types";

export const SFU_EMAIL_DOMAIN = "sfu.ca";

/** Bracketed so it reads as a blank to fill, exactly like `[Your Name]` did. */
export const SENDER_PLACEHOLDER = `[your-sfu-id]@${SFU_EMAIL_DOMAIN}`;

export interface OutreachSender {
  /** The signed-in person's display name. */
  name: string;
  /** The @sfu.ca address to send from, or the placeholder. */
  email: string;
  /** True only when a real @sfu.ca address is configured. */
  configured: boolean;
  /** Why a configured value was refused, or why there is none. Null when fine. */
  problem: string | null;
}

/** `sfu.ca` itself, or a department subdomain of it. Nothing else. */
export function isSfuAddress(value: string): boolean {
  const trimmed = value.trim();
  if (!isEmailShape(trimmed)) return false;
  const domain = trimmed.slice(trimmed.lastIndexOf("@") + 1).toLowerCase();
  return domain === SFU_EMAIL_DOMAIN || domain.endsWith(`.${SFU_EMAIL_DOMAIN}`);
}

export function outreachSender(userName: string): OutreachSender {
  const name = userName.trim() || "Enactus SFU";
  const configured = (process.env.OUTREACH_FROM_EMAIL ?? "").trim();

  if (!configured) {
    return {
      name,
      email: SENDER_PLACEHOLDER,
      configured: false,
      problem:
        `No SFU sending address is configured, so this draft is signed with a placeholder. ` +
        `Set OUTREACH_FROM_EMAIL to the club's @${SFU_EMAIL_DOMAIN} inbox.`,
    };
  }

  if (!isSfuAddress(configured)) {
    return {
      name,
      email: SENDER_PLACEHOLDER,
      configured: false,
      problem:
        `OUTREACH_FROM_EMAIL is not an @${SFU_EMAIL_DOMAIN} address, so it was not used. ` +
        `Outreach sends from an SFU inbox; this draft is signed with a placeholder instead.`,
    };
  }

  return { name, email: configured.toLowerCase(), configured: true, problem: null };
}

/**
 * The sign-off, written by code rather than asked of the model. The model is
 * told not to write one: an address is a fact, and a model that invents one is
 * the failure `src/lib/contact.ts` exists to prevent.
 */
export function signature(sender: OutreachSender, mode: Mode): string {
  const org = mode === "sales" ? "Enactus SFU" : "External Relations, Enactus SFU";
  return `${sender.name}\n${org}\n${sender.email}`;
}

/** The draft as a human would send it: the model's words, then our sign-off. */
export function withSignature(body: string, sender: OutreachSender, mode: Mode): string {
  const written = body.trim();
  // An empty body is a draft the model failed to write, and a signature on its
  // own would disguise that as a short email. The route reports the empty body;
  // this must not paper over it.
  if (!written) return "";
  return `${written}\n\n${signature(sender, mode)}`;
}
