import { describe, test, expect, vi, afterEach } from "vitest";
import { createContactEmailVerifier } from "@/lib/contact";

const deliverable = new Set(["renaissancecoffeesfu.com", "gabiandjules.com"]);
const resolver = async (domain: string) => deliverable.has(domain);

afterEach(() => {
  vi.useRealTimers();
});

describe("contact email verification", () => {
  test("accepts a well-formed address whose domain can receive mail", async () => {
    const verify = createContactEmailVerifier({ resolve: resolver });

    expect(await verify("hello@renaissancecoffeesfu.com")).toEqual({
      ok: true,
      email: "hello@renaissancecoffeesfu.com",
    });
  });

  test("normalises surrounding whitespace and case in the domain", async () => {
    const verify = createContactEmailVerifier({ resolve: resolver });

    expect(await verify("  Hello@Renaissancecoffeesfu.COM ")).toEqual({
      ok: true,
      email: "Hello@renaissancecoffeesfu.com",
    });
  });

  test("rejects a malformed address without spending a DNS lookup", async () => {
    const resolve = vi.fn(resolver);
    const verify = createContactEmailVerifier({ resolve });

    const result = await verify("info at renaissance dot com");

    expect(result).toEqual({ ok: false, email: "info at renaissance dot com", reason: "format" });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("rejects an address whose domain has no mail records", async () => {
    const verify = createContactEmailVerifier({ resolve: resolver });

    // momentenergy.co: the fabricated domain the live-test report caught.
    expect(await verify("hello@momentenergy.co")).toEqual({
      ok: false,
      email: "hello@momentenergy.co",
      reason: "domain",
    });
  });

  test("rejects an empty or non-string value", async () => {
    const verify = createContactEmailVerifier({ resolve: resolver });

    expect((await verify("")).ok).toBe(false);
    expect((await verify(null)).ok).toBe(false);
    expect((await verify(undefined)).ok).toBe(false);
  });

  test("looks each domain up only once per run", async () => {
    const resolve = vi.fn(resolver);
    const verify = createContactEmailVerifier({ resolve });

    await verify("a@gabiandjules.com");
    await verify("b@gabiandjules.com");
    await verify("c@GABIANDJULES.com");

    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test("treats a resolver that fails as unverified rather than throwing", async () => {
    const verify = createContactEmailVerifier({
      resolve: async () => {
        throw new Error("EAI_AGAIN");
      },
    });

    expect(await verify("hello@renaissancecoffeesfu.com")).toEqual({
      ok: false,
      email: "hello@renaissancecoffeesfu.com",
      reason: "domain",
    });
  });

  test("gives up on a hanging resolver instead of stalling the run", async () => {
    vi.useFakeTimers();
    const verify = createContactEmailVerifier({
      resolve: () => new Promise<boolean>(() => {}),
      timeoutMs: 2000,
    });

    const pending = verify("hello@renaissancecoffeesfu.com");
    await vi.advanceTimersByTimeAsync(2001);

    expect(await pending).toEqual({
      ok: false,
      email: "hello@renaissancecoffeesfu.com",
      reason: "domain",
    });
  });
});
