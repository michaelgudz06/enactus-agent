// A hermetic stand-in for node:dns. Nothing here touches the network.
//
// Use it from a test file with:
//   vi.mock("node:dns", async () => (await import("./helpers/dns")).dnsModule());

/** The only domains that exist in the test world. */
export const RESOLVABLE = new Set(["renaissancecoffeesfu.com", "gabiandjules.com", "momentenergy.ca"]);

/**
 * Domains whose lookup fails softly rather than answering. The resolver says
 * nothing about them, so nothing may be concluded about them either.
 */
export const UNREACHABLE = new Set(["slow-resolver.example"]);

/** Every domain a run looked up, in order. */
export const lookups: string[] = [];

function softFailure(): Error {
  return Object.assign(new Error("queryMx EAI_AGAIN"), { code: "EAI_AGAIN" });
}

export function dnsModule() {
  return {
    promises: {
      resolveMx: async (domain: string) => {
        lookups.push(domain);
        if (UNREACHABLE.has(domain)) throw softFailure();
        if (RESOLVABLE.has(domain)) return [{ exchange: `mx.${domain}`, priority: 1 }];
        throw new Error("ENOTFOUND");
      },
      resolve4: async (domain: string) => {
        if (UNREACHABLE.has(domain)) throw softFailure();
        throw new Error("ENOTFOUND");
      },
      resolve6: async (domain: string) => {
        if (UNREACHABLE.has(domain)) throw softFailure();
        throw new Error("ENOTFOUND");
      },
    },
  };
}
