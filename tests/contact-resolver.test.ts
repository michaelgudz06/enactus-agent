import { describe, test, expect, beforeEach, vi } from "vitest";

// The real resolver against a stand-in for node:dns. Nothing here touches the
// network; each case is one of the answers a DNS server actually gives.
const dns = vi.hoisted(() => ({
  mx: null as (() => unknown) | null,
  a: null as (() => unknown) | null,
  aaaa: null as (() => unknown) | null,
}));

vi.mock("node:dns", () => ({
  promises: {
    resolveMx: async () => dns.mx!(),
    resolve4: async () => dns.a!(),
    resolve6: async () => dns.aaaa!(),
  },
}));

const { dnsMailResolver } = await import("@/lib/contact");

function fails(code?: string) {
  return () => {
    throw code ? Object.assign(new Error(`query ${code}`), { code }) : new Error("ENOTFOUND");
  };
}

beforeEach(() => {
  dns.mx = fails("ENOTFOUND");
  dns.a = fails("ENOTFOUND");
  dns.aaaa = fails("ENOTFOUND");
});

describe("the mail-record resolver", () => {
  test("answers true on an MX record", async () => {
    dns.mx = () => [{ exchange: "aspmx.l.google.com", priority: 1 }];

    expect(await dnsMailResolver("gabiandjules.com")).toBe(true);
  });

  test("answers true on an address record under the implicit-MX rule", async () => {
    dns.a = () => ["203.0.113.10"];

    expect(await dnsMailResolver("renaissancecoffeesfu.com")).toBe(true);
  });

  // Every lookup came back with a real answer and found nothing. That is a
  // conclusion, and the caller may report it as one.
  test("answers false when every lookup completed and found no record", async () => {
    expect(await dnsMailResolver("momentenergy.co")).toBe(false);
  });

  // The server was busy or unreachable. Nothing was established, so the resolver
  // refuses to hand back a negative the caller would report as fact.
  test("refuses to answer when a lookup failed softly", async () => {
    dns.mx = fails("EAI_AGAIN");

    await expect(dnsMailResolver("gabiandjules.com")).rejects.toMatchObject({ code: "EAI_AGAIN" });
  });

  test("refuses to answer on a server failure part-way through", async () => {
    dns.a = fails("ESERVFAIL");

    await expect(dnsMailResolver("gabiandjules.com")).rejects.toMatchObject({ code: "ESERVFAIL" });
  });

  test("still answers true when a soft failure is followed by a real record", async () => {
    dns.mx = fails("EAI_AGAIN");
    dns.a = () => ["203.0.113.10"];

    expect(await dnsMailResolver("gabiandjules.com")).toBe(true);
  });
});
