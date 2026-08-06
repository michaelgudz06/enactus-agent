import { describe, test, expect, beforeEach, vi } from "vitest";
import { CANDIDATES, PLAN, collector, rawLead, respondsWith } from "./helpers/fixtures";

const stub = vi.hoisted(() => ({
  chatJSON: vi.fn(),
  streamReasoner: vi.fn(),
  exaSearch: vi.fn(),
}));

vi.mock("node:dns", async () => (await import("./helpers/dns")).dnsModule());
vi.mock("@/lib/llm", async (orig) => ({
  ...(await orig<typeof import("@/lib/llm")>()),
  chatJSON: stub.chatJSON,
  streamReasoner: stub.streamReasoner,
}));
vi.mock("@/lib/exa", async (orig) => ({
  ...(await orig<typeof import("@/lib/exa")>()),
  exaSearch: stub.exaSearch,
}));

const { runAgent } = await import("@/lib/agent");

beforeEach(() => {
  vi.clearAllMocks();
  stub.exaSearch.mockResolvedValue(CANDIDATES);
  stub.streamReasoner.mockResolvedValue({ reasoning: "Analyst reasoning.", content: "" });
});

async function runWithLeads(leads: unknown[]) {
  stub.chatJSON.mockImplementationOnce(respondsWith(PLAN)).mockImplementationOnce(respondsWith({ leads }));
  const { emit, out } = collector();
  await runAgent({ prompt: "burnaby cafes near sfu", mode: "sponsor", userName: "Tester", skipClarify: true }, emit);
  return out;
}

// A defect is confined to the field it is in. The whole class, not one instance:
// a single batch carrying a wrong type, an off-enum value and a missing optional
// field at once, none of which may cost another lead.
describe("a defective field costs that field only", () => {
  test("keeps every other lead and normalises the damaged one", async () => {
    const damaged = rawLead({
      company: "Gabi & Jules",
      source_index: 2,
      fit_score: "88",
      connection_type: "partner",
      why_fit: undefined,
    });

    const out = await runWithLeads([
      rawLead(),
      damaged,
      rawLead({ company: "BAK'D Cookies", source_index: 1 }),
    ]);

    expect(out.errors).toEqual([]);
    expect(out.leads.map((l) => l.company)).toEqual(["Renaissance Coffee", "Gabi & Jules", "BAK'D Cookies"]);

    // The damaged lead is kept: the recoverable field is read, the rest fall
    // back to their defaults.
    const [first, hurt, last] = out.leads;
    expect(hurt.fit_score).toBe(88);
    expect(hurt.connection_type).toBe("none");
    expect(hurt.why_fit).toBeNull();
    expect(hurt.description).toBe("Campus cafe operating at SFU Burnaby for 30 years.");

    // Its neighbours are untouched.
    expect(first.fit_score).toBe(95);
    expect(first.connection_type).toBe("ecosystem");
    expect(last.fit_score).toBe(95);
    expect(last.connection_type).toBe("ecosystem");
  });

  test("reports each defective field with the company, the field and the value received", async () => {
    const out = await runWithLeads([
      rawLead(),
      rawLead({ company: "Gabi & Jules", source_index: 2, fit_score: "88", connection_type: "partner" }),
    ]);

    const reported = out.statuses.filter((s) => s.includes("Gabi & Jules"));

    expect(reported.some((s) => s.includes("fit_score") && s.includes("88"))).toBe(true);
    expect(reported.some((s) => s.includes("connection_type") && s.includes("partner"))).toBe(true);
  });

  test("says nothing about leads that are clean", async () => {
    const out = await runWithLeads([rawLead(), rawLead({ company: "Gabi & Jules", source_index: 2 })]);

    expect(out.statuses.some((s) => /ignoring|Dropped|read /.test(s))).toBe(false);
  });

  // The strict schema this run sends lists connection_type as required with null
  // among its allowed values, so null is the model reporting no tie -- reporting
  // it as misbehaviour would train the reader to ignore the stream.
  test("treats a null connection_type as no tie rather than a defect", async () => {
    const out = await runWithLeads([
      rawLead({ connection_type: null }),
      rawLead({ company: "Gabi & Jules", source_index: 2, connection_type: null }),
    ]);

    expect(out.leads.map((l) => l.connection_type)).toEqual(["none", "none"]);
    expect(out.statuses.some((s) => s.includes("connection_type"))).toBe(false);
  });

  test("still reports an unrecognised connection that is not null", async () => {
    const out = await runWithLeads([rawLead({ connection_type: "partner" })]);

    expect(out.leads[0].connection_type).toBe("none");
    expect(out.statuses.some((s) => s.includes("connection_type") && s.includes("partner"))).toBe(true);
  });

  test("survives a wrongly typed field that the persist path would have thrown on", async () => {
    const out = await runWithLeads([
      rawLead({ company: "Gabi & Jules", source_index: 2, reasoning: 42, why_fit: "A winnable in-kind ask." }),
      rawLead(),
    ]);

    expect(out.errors).toEqual([]);
    expect(out.leads.map((l) => l.company)).toEqual(["Gabi & Jules", "Renaissance Coffee"]);
    expect(out.leads[0].reasoning).toBe("A winnable in-kind ask.");
    expect(out.statuses.some((s) => s.includes("reasoning") && s.includes("42"))).toBe(true);
  });

  test("keeps a list that is the wrong type entirely out of the record", async () => {
    const out = await runWithLeads([rawLead({ company: "Gabi & Jules", sponsorship_type: 42 })]);

    expect(out.leads).toHaveLength(1);
    expect(out.leads[0].sponsorship_type).toEqual([]);
    expect(out.statuses.some((s) => s.includes("sponsorship_type"))).toBe(true);
  });
});

// A wrong type with exactly one possible reading is a slip, not an ambiguity.
describe("a recoverable value is read rather than thrown away", () => {
  test("reads a stringified fit score and still clamps it", async () => {
    const out = await runWithLeads([
      rawLead({ fit_score: "88.4" }),
      rawLead({ company: "Gabi & Jules", source_index: 2, fit_score: "140" }),
    ]);

    expect(out.leads[0].fit_score).toBe(88);
    expect(out.leads[1].fit_score).toBe(100);
  });

  test("reports the recovery as the coercion it is", async () => {
    const out = await runWithLeads([rawLead({ fit_score: "88" })]);

    const reported = out.statuses.filter((s) => s.includes("fit_score"));

    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("88");
    expect(reported[0]).toMatch(/read fit_score/);
  });

  test("reads a stringified source index and still bounds-checks it", async () => {
    const out = await runWithLeads([
      rawLead({ company: "Gabi & Jules", source_index: "2", website: null }),
      rawLead({ company: "BAK'D Cookies", source_index: "99", website: null }),
    ]);

    expect(out.leads[0].sources).toEqual([
      { url: "https://gabiandjules.com/pages/about-us", title: "Gabi & Jules" },
    ]);
    expect(out.leads[1].sources).toEqual([]);
    expect(out.statuses.some((s) => s.includes("source_index"))).toBe(true);
  });

  // A fabricated attribution is a louder slip than a mistyped field, so it must
  // not be the one that passes unannounced.
  test("reports a cited candidate that does not exist, and keeps the lead", async () => {
    const out = await runWithLeads([
      rawLead({ company: "Gabi & Jules", source_index: 99, website: null }),
      rawLead(),
    ]);

    expect(out.leads.map((l) => l.company)).toEqual(["Gabi & Jules", "Renaissance Coffee"]);
    expect(out.leads[0].sources).toEqual([]);
    const reported = out.statuses.filter((s) => s.includes("Gabi & Jules") && s.includes("source_index"));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("99");
    expect(reported[0]).toContain("3");
  });

  test("distinguishes a source the model never named from one that does not exist", async () => {
    const out = await runWithLeads([rawLead({ company: "Gabi & Jules", source_index: null, website: null })]);

    expect(out.leads[0].sources).toEqual([]);
    const reported = out.statuses.filter((s) => s.includes("source_index"));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatch(/named no source/i);
    expect(reported[0]).not.toContain("cited candidate");
  });

  // A lone value where a list was asked for reads as a list of one, on the same
  // rule that reads "88" as 88. Losing a usable sponsorship angle to a typo is
  // the same defect as losing a usable score to one.
  test("reads a single list entry sent as a bare string", async () => {
    const out = await runWithLeads([rawLead({ company: "Gabi & Jules", sponsorship_type: "in_kind" })]);

    expect(out.leads).toHaveLength(1);
    expect(out.leads[0].sponsorship_type).toEqual(["in_kind"]);
    expect(out.statuses.some((s) => s.includes("sponsorship_type"))).toBe(true);
  });

  // One unusable entry may not cost the entries beside it, exactly as one
  // unusable lead may not cost the leads beside it.
  test("keeps the usable entries of a partly malformed list", async () => {
    const out = await runWithLeads([
      rawLead({ company: "Gabi & Jules", sponsorship_type: ["monetary", 42, "in_kind"] }),
    ]);

    expect(out.leads[0].sponsorship_type).toEqual(["monetary", "in_kind"]);
    expect(out.statuses.some((s) => s.includes("sponsorship_type"))).toBe(true);
  });

  test("leaves a value with no single reading alone", async () => {
    const out = await runWithLeads([
      rawLead({ fit_score: "high" }),
      rawLead({ company: "Gabi & Jules", source_index: 2, fit_score: "" }),
      rawLead({ company: "BAK'D Cookies", source_index: 1, fit_score: { value: 90 } }),
    ]);

    expect(out.leads.map((l) => l.fit_score)).toEqual([null, null, null]);
    expect(out.statuses.filter((s) => s.includes("ignoring fit_score"))).toHaveLength(3);
  });
});

// What decides whether a lead survives is read on the same rule as the fields
// behind it, so a single-reading slip cannot cost a fully researched lead.
describe("a single-reading slip in what decides survival costs no lead", () => {
  test("keeps a lead whose company arrived as a list of one", async () => {
    const out = await runWithLeads([rawLead({ company: ["Gabi & Jules"], source_index: 2 })]);

    expect(out.errors).toEqual([]);
    expect(out.leads.map((l) => l.company)).toEqual(["Gabi & Jules"]);
  });

  test("keeps a lead that arrived wrapped in a list of one", async () => {
    const out = await runWithLeads([[rawLead()]]);

    expect(out.errors).toEqual([]);
    expect(out.leads.map((l) => l.company)).toEqual(["Renaissance Coffee"]);
  });

  // Each recovery is whatever the run says that the same batch, arriving in the
  // shape that was asked for, does not say.
  test("announces the company it read", async () => {
    const clean = await runWithLeads([rawLead({ company: "Gabi & Jules", source_index: 2 })]);
    const recovered = await runWithLeads([rawLead({ company: ["Gabi & Jules"], source_index: 2 })]);

    expect(recovered.leads.map((l) => l.company)).toEqual(clean.leads.map((l) => l.company));
    expect(recovered.statuses.filter((s) => !clean.statuses.includes(s))).toHaveLength(1);
  });

  test("announces the lead it unwrapped", async () => {
    const clean = await runWithLeads([rawLead()]);
    const wrapped = await runWithLeads([[rawLead()]]);

    expect(wrapped.leads.map((l) => l.company)).toEqual(clean.leads.map((l) => l.company));
    expect(wrapped.statuses.filter((s) => !clean.statuses.includes(s))).toHaveLength(1);
  });

  // Recovery applies only where there is exactly one reading. Everything else is
  // still a drop, and still costs only the record that carries it.
  const NO_SINGLE_READING: Record<string, unknown> = {
    "a blank company name": rawLead({ company: "   ", source_index: 2 }),
    "a company that is a list of several": rawLead({ company: ["Gabi & Jules", "BAK'D Cookies"], source_index: 2 }),
    "a company that is an empty list": rawLead({ company: [], source_index: 2 }),
    "an entry that is a list of several leads": [
      rawLead({ company: "Gabi & Jules", source_index: 2 }),
      rawLead({ company: "BAK'D Cookies", source_index: 1 }),
    ],
    "an entry that is an empty list": [],
    "an entry that is not an object": "Gabi & Jules",
  };

  for (const [shape, entry] of Object.entries(NO_SINGLE_READING)) {
    test(`still drops ${shape}, and only that record`, async () => {
      const out = await runWithLeads([rawLead(), entry]);

      expect(out.leads.map((l) => l.company)).toEqual(["Renaissance Coffee"]);
      expect(out.statuses.some((s) => /Dropped lead 2/.test(s))).toBe(true);
    });
  }
});

// Dropping is reserved for a record that cannot be put on a card at all.
describe("an unusable record is dropped and reported", () => {
  test("drops a lead with no company name and keeps the rest", async () => {
    const out = await runWithLeads([
      rawLead(),
      { fit_score: 90, why_fit: "No name at all." },
      rawLead({ company: "BAK'D Cookies", source_index: 1 }),
    ]);

    expect(out.errors).toEqual([]);
    expect(out.leads.map((l) => l.company)).toEqual(["Renaissance Coffee", "BAK'D Cookies"]);
    expect(out.statuses.some((s) => /Dropped lead 2/.test(s) && /company/.test(s))).toBe(true);
  });

  test("drops a lead whose company name is the wrong type and keeps the rest", async () => {
    const out = await runWithLeads([rawLead({ company: 42 }), rawLead({ company: "Gabi & Jules", source_index: 2 })]);

    expect(out.leads.map((l) => l.company)).toEqual(["Gabi & Jules"]);
    expect(out.statuses.some((s) => /Dropped lead 1/.test(s) && s.includes("42"))).toBe(true);
  });

  test("drops an entry that is not an object at all and keeps the rest", async () => {
    const out = await runWithLeads(["Renaissance Coffee", rawLead()]);

    expect(out.leads.map((l) => l.company)).toEqual(["Renaissance Coffee"]);
    expect(out.statuses.some((s) => /Dropped lead 1/.test(s))).toBe(true);
  });

  test("never presents a dropped lead as persisted", async () => {
    const out = await runWithLeads([{ why_fit: "nameless" }]);

    expect(out.leads).toEqual([]);
    expect(out.events.some((e) => e.type === "done" && e.count === 0)).toBe(true);
  });

  // This suite runs with no service key, so nothing is written anywhere. A run
  // that says otherwise is the board-looks-full-then-empty failure.
  test("counts nothing as saved when there is no database to save to", async () => {
    const out = await runWithLeads([rawLead(), rawLead({ company: "Gabi & Jules", source_index: 2 })]);

    expect(out.leads).toHaveLength(2);
    expect(out.events.some((e) => e.type === "done" && e.count === 2 && e.saved === 0)).toBe(true);
  });
});
