import { getDefaultResultOrder, setDefaultResultOrder } from "node:dns";
import { afterEach, describe, expect, it } from "vitest";

import { configureProviderNetwork } from "./network-runtime.ts";

describe("configureProviderNetwork", () => {
  const originalOrder = getDefaultResultOrder();

  afterEach(() => setDefaultResultOrder(originalOrder));

  it("prefers IPv4 while retaining the normal dual-stack fallback", () => {
    setDefaultResultOrder("verbatim");

    configureProviderNetwork();

    expect(getDefaultResultOrder()).toBe("ipv4first");
  });
});
