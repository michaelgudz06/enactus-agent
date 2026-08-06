import { describe, test, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LeadCard from "@/components/LeadCard";
import { Lead } from "@/lib/types";

// The card used to carry a coloured badge with the lead's raw 0-100 fit score
// in its header. A number that size anchors how a student reads the lead before
// they read anything about the company, so it stopped being shown. The score is
// still on the lead, still computed, and still orders the board — these tests
// pin the display half of that: nothing the card renders may depend on it.

function lead(over: Partial<Lead> = {}): Lead {
  return {
    id: "l1",
    company: "Renaissance Coffee",
    website: null,
    website_status: null,
    industry: "Food & Beverage",
    description: "Campus cafe operating at SFU Burnaby.",
    contact_name: null,
    contact_role: null,
    contact_email: null,
    contact_email_status: null,
    location: "Burnaby, BC",
    connection_type: "ecosystem",
    connection_note: null,
    sponsorship_type: ["in_kind"],
    fit_score: 95,
    why_fit: "Long-standing campus presence makes an in-kind ask winnable.",
    reasoning: null,
    sources: [],
    status: "prospects",
    mode: "sponsor",
    board_order: 1,
    created_by_name: "Michael",
    created_at: "2026-08-05T10:00:00.000Z",
    updated_at: "2026-08-05T10:00:00.000Z",
    ...over,
  };
}

const render = (l: Lead) => renderToStaticMarkup(createElement(LeadCard, { lead: l }));
const visibleText = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

describe("LeadCard", () => {
  // Every band the removed colour helper had, plus the boundaries between them.
  test.each([100, 95, 80, 79, 72, 60, 41, 39, 8, 0])("a fit score of %i is never shown", (score) => {
    const html = render(lead({ fit_score: score }));
    expect(visibleText(html)).not.toMatch(new RegExp(`\\b${score}\\b`));
  });

  test("the card renders the same whether or not the lead carries a score", () => {
    // The badge was the only thing on the card that read fit_score, so a scored
    // lead and an unscored one must now produce byte-identical markup — which
    // also means no gap is left where the badge used to sit.
    expect(render(lead({ fit_score: 95 }))).toBe(render(lead({ fit_score: null })));
  });

  test("the company, industry and location still read in that order", () => {
    const text = visibleText(render(lead()));
    expect(text).toContain("Renaissance Coffee");
    expect(text.indexOf("Renaissance Coffee")).toBeLessThan(text.indexOf("Food & Beverage"));
    expect(text.indexOf("Food & Beverage")).toBeLessThan(text.indexOf("Burnaby, BC"));
  });

  test("the score is still on the lead the card was handed", () => {
    // The card only stopped displaying it; nothing about the data changed.
    const l = lead({ fit_score: 88 });
    render(l);
    expect(l.fit_score).toBe(88);
  });
});
