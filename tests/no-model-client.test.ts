// INVARIANT 1 of AGENTS.md: neither src/lib/filter.ts nor src/lib/scoring.ts may reach a model
// client, not even as a fallback.
//
// This is proved by EXECUTION, not by reading the source. Every module that owns a model or
// search-API call is replaced with a factory that throws the moment it is requested; the module
// under test is then imported fresh and actually run. If anything in its transitive import graph
// reaches the boundary, the import rejects and the test fails. A re-export barrel, a renamed
// local or a dynamic `await import()` cannot slip past this the way a source grep can.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every module in this repo that talks to a model or a paid search API. */
const MODEL_BOUNDARY = ["../src/lib/llm", "../src/lib/exa"] as const;

const NOW = new Date("2026-08-06T12:00:00.000Z");

/** Boundary modules the run under test actually pulled in. Must stay empty. */
const loaded: string[] = [];

function armBoundaryTraps() {
  for (const path of MODEL_BOUNDARY) {
    vi.doMock(path, () => {
      loaded.push(path);
      throw new Error(`the module under test loaded the model boundary ${path}`);
    });
  }
}

beforeEach(() => {
  loaded.length = 0;
  vi.resetModules();
  armBoundaryTraps();
});

afterEach(() => {
  for (const path of MODEL_BOUNDARY) vi.doUnmock(path);
  vi.resetModules();
});

describe("the model boundary", () => {
  // The control. Without this, a broken trap would make every assertion below vacuously true:
  // tests/fixtures/reaches-model-client.ts genuinely imports the model client, so it MUST trip
  // the trap. The fixture is owned by this suite, so a parallel rewrite of src/lib/agent.ts
  // cannot break the control and tempt someone into deleting it.
  it("actually trips — a module that DOES reach a model client fails to import", async () => {
    await expect(import("./fixtures/reaches-model-client")).rejects.toThrow();
    expect(loaded).toContain("../src/lib/llm");
  });

  it("filter.ts loads and filters an account with the traps armed", async () => {
    const { runFilter } = await import("../src/lib/filter");
    const { loadQualificationLists } = await import("../src/lib/qualification-lists");
    const lists = loadQualificationLists(undefined, { reload: true });

    const result = runFilter(
      {
        legal_name: "Crema Artisan Bakers",
        registrable_domain: "cremabakers.ca",
        email: "info@cremabakers.ca",
        address_municipality: "Burnaby",
        address_region: "BC",
        address_country: "CA",
      },
      lists,
      { now: NOW },
    );

    expect(result.decision).toBe("pass");
    expect(result.kills).toEqual([]);
    expect(loaded).toEqual([]);
  });

  it("scoring.ts loads and scores a company with the traps armed", async () => {
    const { scoreCompany } = await import("../src/lib/scoring");
    const { loadIcpConfig } = await import("../src/lib/icp-config");
    const { loadQualificationLists } = await import("../src/lib/qualification-lists");
    const lists = loadQualificationLists(undefined, { reload: true });

    const result = scoreCompany(
      {
        legal_name: "Crema Artisan Bakers",
        has_consumer_storefront: true,
        municipality: "Burnaby",
        relationship_tier: "cold",
        alumni_evidence: "none",
        project_match: "none",
        lawful_basis_strength: "none",
      },
      loadIcpConfig(),
      { lists, now: NOW },
    );

    expect(result.fit.score).toBeGreaterThan(0);
    // The other half of the invariant: three scores, never blended into one.
    expect(result).not.toHaveProperty("total");
    expect(loaded).toEqual([]);
  });
});
