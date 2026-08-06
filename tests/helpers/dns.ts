// A hermetic stand-in for node:dns. Nothing here touches the network.
//
// Use it from a test file with:
//   vi.mock("node:dns", async () => (await import("./helpers/dns")).dnsModule());

/** The only domains that exist in the test world. */
export const RESOLVABLE = new Set(["renaissancecoffeesfu.com", "gabiandjules.com", "momentenergy.ca"]);

/** Every domain a run looked up, in order. */
export const lookups: string[] = [];

export function dnsModule() {
  return {
    promises: {
      resolveMx: async (domain: string) => {
        lookups.push(domain);
        if (RESOLVABLE.has(domain)) return [{ exchange: `mx.${domain}`, priority: 1 }];
        throw new Error("ENOTFOUND");
      },
      resolve4: async () => {
        throw new Error("ENOTFOUND");
      },
      resolve6: async () => {
        throw new Error("ENOTFOUND");
      },
    },
  };
}
