import { describe, test, expect, afterEach, vi } from "vitest";
import { SENDER_PLACEHOLDER, isSfuAddress, outreachSender, signature, withSignature } from "@/lib/sender";

afterEach(() => {
  vi.unstubAllEnvs();
});

function withFrom(value: string | null) {
  if (value === null) vi.stubEnv("OUTREACH_FROM_EMAIL", "");
  else vi.stubEnv("OUTREACH_FROM_EMAIL", value);
  return outreachSender("Nikita");
}

// Outreach sends from an SFU inbox. The domain is the whole point of the
// ruling: an @sfu.ca address is what gives a cold email to a Lower Mainland
// business the university's weight behind it.
describe("the sending address must be an SFU one", () => {
  test("accepts the club's SFU inbox", () => {
    const sender = withFrom("enactus@sfu.ca");

    expect(sender.email).toBe("enactus@sfu.ca");
    expect(sender.configured).toBe(true);
    expect(sender.problem).toBeNull();
  });

  test("accepts a department subdomain of sfu.ca", () => {
    expect(isSfuAddress("someone@beedie.sfu.ca")).toBe(true);
  });

  test("normalises the case, since a mailbox is not case sensitive in its domain", () => {
    expect(withFrom("Enactus@SFU.ca").email).toBe("enactus@sfu.ca");
  });

  // Quietly signing from a personal mailbox would defeat the ruling while
  // looking entirely fine on screen, which is the worst shape a failure has.
  const NOT_SFU: Record<string, string> = {
    "a personal gmail": "enactussfu@gmail.com",
    "a lookalike domain": "someone@sfu.ca.example.com",
    "another university": "someone@ubc.ca",
    "a domain that merely ends in the letters": "someone@notsfu.ca",
    "not an address at all": "the club inbox",
  };

  for (const [shape, value] of Object.entries(NOT_SFU)) {
    test(`refuses ${shape} rather than sending from it`, () => {
      const sender = withFrom(value);

      expect(sender.configured).toBe(false);
      expect(sender.email).toBe(SENDER_PLACEHOLDER);
      expect(sender.problem).toContain("sfu.ca");
    });
  }

  test("a lookalike domain is not an SFU address", () => {
    expect(isSfuAddress("someone@notsfu.ca")).toBe(false);
    expect(isSfuAddress("someone@sfu.ca.example.com")).toBe(false);
  });
});

// A guard that fires early is worse than no guard: a student with a lead in
// front of them still gets a draft, and the blank is obvious rather than
// invented.
describe("with nothing configured", () => {
  test("still writes the draft, signed with an obvious placeholder", () => {
    const sender = withFrom(null);

    expect(sender.email).toBe(SENDER_PLACEHOLDER);
    expect(sender.email).toContain("@sfu.ca");
    expect(sender.email).toMatch(/^\[/);
  });

  test("says what to set, so the blank is fixable", () => {
    expect(withFrom(null).problem).toContain("OUTREACH_FROM_EMAIL");
  });
});

// The sign-off is code's, not the model's. An email address is a fact, and a
// model asked for one will invent one.
describe("the signature", () => {
  test("carries the sender, the club and the SFU address", () => {
    const sender = withFrom("enactus@sfu.ca");

    expect(signature(sender, "sponsor")).toBe("Nikita\nExternal Relations, Enactus SFU\nenactus@sfu.ca");
  });

  test("drops the External Relations line when the mode is not sponsorship", () => {
    expect(signature(withFrom("enactus@sfu.ca"), "sales")).toBe("Nikita\nEnactus SFU\nenactus@sfu.ca");
  });

  test("is appended after the model's own words", () => {
    const body = withSignature("Hi there, could we borrow 15 minutes?", withFrom("enactus@sfu.ca"), "sponsor");

    expect(body).toBe("Hi there, could we borrow 15 minutes?\n\nNikita\nExternal Relations, Enactus SFU\nenactus@sfu.ca");
  });

  // An empty body is a draft the model failed to write. A signature on its own
  // would disguise that as a short email, and the route's own note about the
  // missing body would read as pedantry next to it.
  test("is not added to a body the model never wrote", () => {
    expect(withSignature("", withFrom("enactus@sfu.ca"), "sponsor")).toBe("");
    expect(withSignature("   ", withFrom("enactus@sfu.ca"), "sponsor")).toBe("");
  });

  test("falls back to the club's name when nobody is signed in under a name", () => {
    vi.stubEnv("OUTREACH_FROM_EMAIL", "enactus@sfu.ca");

    expect(outreachSender("  ").name).toBe("Enactus SFU");
  });
});
