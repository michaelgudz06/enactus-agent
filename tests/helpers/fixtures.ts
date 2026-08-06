import { AgentEvent, Lead } from "@/lib/types";
import type { ExaResult } from "@/lib/exa";

export function exaResult(url: string, title: string, text = "Some page text."): ExaResult {
  return { url, title, publishedDate: null, author: null, text, highlights: [] };
}

// Three candidates modelled on run r7 from the live-test report: the Burnaby
// café search whose leads were all discarded.
export const CANDIDATES: ExaResult[] = [
  exaResult("https://renaissancecoffeesfu.com/", "Renaissance Coffee"),
  exaResult("https://gabiandjules.com/pages/about-us", "Gabi & Jules"),
  exaResult("https://www.linkedin.com/posts/ophelia-yu_sfugivingday", "SFU Giving Day post"),
];

export const PLAN = {
  needClarification: false,
  questions: [],
  searchQueries: ["burnaby cafes near sfu", "sfu campus coffee", "burnaby bakery community"],
  criteria: "Small independent Burnaby food businesses near SFU",
  altAngle: "Try Vancouver instead",
  location: "Burnaby, BC",
};

export function rawLead(over: Record<string, unknown> = {}) {
  return {
    company: "Renaissance Coffee",
    website: "https://renaissancecoffeesfu.com/",
    industry: "Food & Beverage",
    location: "Burnaby, BC",
    description: "Campus cafe operating at SFU Burnaby for 30 years.",
    contact_name: null,
    contact_role: null,
    contact_email: null,
    connection_type: "ecosystem",
    connection_note: "Operates on the SFU Burnaby campus.",
    sponsorship_type: ["in_kind"],
    fit_score: 95,
    why_fit: "Long-standing campus presence makes an in-kind ask winnable.",
    reasoning: "Renaissance Coffee has served SFU Burnaby for three decades.",
    source_index: 1,
    ...over,
  };
}

export interface Collected {
  events: AgentEvent[];
  leads: Lead[];
  errors: string[];
  statuses: string[];
}

export function collector(): { emit: (e: AgentEvent) => void; out: Collected } {
  const out: Collected = { events: [], leads: [], errors: [], statuses: [] };
  return {
    out,
    emit(e: AgentEvent) {
      out.events.push(e);
      if (e.type === "lead") out.leads.push(e.lead);
      if (e.type === "error") out.errors.push(e.message);
      if (e.type === "status") out.statuses.push(e.message);
    },
  };
}
