import { describe, test, expect, vi, afterEach } from "vitest";
import { createVerifiers } from "@/lib/contact";

const deliverable = new Set(["renaissancecoffeesfu.com", "gabiandjules.com"]);
const resolver = async (domain: string) => deliverable.has(domain);

afterEach(() => {
  vi.useRealTimers();
});

describe("contact email verification", () => {
  test("accepts a well-formed address whose domain can receive mail", async () => {
    const { email: verify } = createVerifiers({ resolve: resolver });

    expect(await verify("hello@renaissancecoffeesfu.com")).toEqual({
      ok: true,
      email: "hello@renaissancecoffeesfu.com",
    });
  });

  test("normalises surrounding whitespace and case in the domain", async () => {
    const { email: verify } = createVerifiers({ resolve: resolver });

    expect(await verify("  Hello@Renaissancecoffeesfu.COM ")).toEqual({
      ok: true,
      email: "Hello@renaissancecoffeesfu.com",
    });
  });

  test("rejects a malformed address without spending a DNS lookup", async () => {
    const resolve = vi.fn(resolver);
    const { email: verify } = createVerifiers({ resolve });

    const result = await verify("info at renaissance dot com");

    expect(result).toEqual({ ok: false, email: "info at renaissance dot com", reason: "format" });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("rejects an address whose domain has no mail records", async () => {
    const { email: verify } = createVerifiers({ resolve: resolver });

    // momentenergy.co: the fabricated domain the live-test report caught.
    expect(await verify("hello@momentenergy.co")).toEqual({
      ok: false,
      email: "hello@momentenergy.co",
      reason: "domain",
    });
  });

  test("rejects an empty or non-string value", async () => {
    const { email: verify } = createVerifiers({ resolve: resolver });

    expect((await verify("")).ok).toBe(false);
    expect((await verify(null)).ok).toBe(false);
    expect((await verify(undefined)).ok).toBe(false);
  });

  test("looks each domain up only once per run", async () => {
    const resolve = vi.fn(resolver);
    const { email: verify } = createVerifiers({ resolve });

    await verify("a@gabiandjules.com");
    await verify("b@gabiandjules.com");
    await verify("c@GABIANDJULES.com");

    expect(resolve).toHaveBeenCalledTimes(1);
  });

  // A lookup that never completed is not evidence that the domain is fake, and
  // must not be recorded as though it were.
  test("treats a resolver that fails as not checked rather than as a bad domain", async () => {
    const { email: verify } = createVerifiers({
      resolve: async () => {
        throw new Error("EAI_AGAIN");
      },
    });

    expect(await verify("hello@renaissancecoffeesfu.com")).toEqual({
      ok: false,
      email: "hello@renaissancecoffeesfu.com",
      reason: "unverified",
    });
  });

  test("gives up on a hanging resolver instead of stalling the run, and says it never checked", async () => {
    vi.useFakeTimers();
    const { email: verify } = createVerifiers({
      resolve: () => new Promise<boolean>(() => {}),
      timeoutMs: 2000,
    });

    const pending = verify("hello@renaissancecoffeesfu.com");
    await vi.advanceTimersByTimeAsync(2001);

    expect(await pending).toEqual({
      ok: false,
      email: "hello@renaissancecoffeesfu.com",
      reason: "unverified",
    });
  });

  test("keeps calling a completed no-records answer a bad domain", async () => {
    const { email: verify } = createVerifiers({ resolve: async () => false });

    expect(await verify("hello@momentenergy.co")).toEqual({
      ok: false,
      email: "hello@momentenergy.co",
      reason: "domain",
    });
  });
});

describe("company website verification", () => {
  test("accepts a website whose domain resolves", async () => {
    const { website } = createVerifiers({ resolve: resolver });

    expect(await website("https://renaissancecoffeesfu.com/")).toEqual({
      ok: true,
      url: "https://renaissancecoffeesfu.com/",
    });
  });

  test("completes a bare domain into a URL", async () => {
    const { website } = createVerifiers({ resolve: resolver });

    expect(await website("gabiandjules.com")).toEqual({ ok: true, url: "https://gabiandjules.com/" });
  });

  test("rejects a domain that does not resolve", async () => {
    const { website } = createVerifiers({ resolve: resolver });

    expect(await website("https://momentenergy.co")).toEqual({
      ok: false,
      url: "https://momentenergy.co",
      reason: "domain",
    });
  });

  test("rejects an aggregator or social host without spending a lookup", async () => {
    const resolve = vi.fn(resolver);
    const { website } = createVerifiers({ resolve });

    expect(await website("https://www.linkedin.com/company/bakd")).toEqual({
      ok: false,
      url: "https://www.linkedin.com/company/bakd",
      reason: "aggregator",
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("rejects a hedged or narrated answer without spending a lookup", async () => {
    const resolve = vi.fn(resolver);
    const { website } = createVerifiers({ resolve });

    const result = await website("https://renaissancecoffee.ca/ (example website)");

    expect(result).toEqual({
      ok: false,
      url: "https://renaissancecoffee.ca/ (example website)",
      reason: "format",
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("rejects a non-web scheme and an empty value", async () => {
    const { website } = createVerifiers({ resolve: resolver });

    expect((await website("javascript:alert(1)")).ok).toBe(false);
    expect((await website("their storefront")).ok).toBe(false);
    expect((await website("")).ok).toBe(false);
    expect((await website(null)).ok).toBe(false);
  });

  test("separates a domain that does not resolve from one it could not check", async () => {
    const answered = createVerifiers({ resolve: async () => false });
    const unreachable = createVerifiers({
      resolve: async () => {
        throw Object.assign(new Error("queryMx ESERVFAIL"), { code: "ESERVFAIL" });
      },
    });

    expect(await answered.website("https://momentenergy.co")).toEqual({
      ok: false,
      url: "https://momentenergy.co",
      reason: "domain",
    });
    expect(await unreachable.website("https://momentenergy.co")).toEqual({
      ok: false,
      url: "https://momentenergy.co",
      reason: "unverified",
    });
  });

  test("shares one lookup between an address and a website on the same domain", async () => {
    const resolve = vi.fn(resolver);
    const { email, website } = createVerifiers({ resolve });

    await Promise.all([email("hello@gabiandjules.com"), website("https://gabiandjules.com/about")]);

    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
