import { describe, expect, it, vi } from "vitest";
import { createProviderNetworkTransport } from "./provider-network-transport.ts";

const target = {
  url: new URL("https://provider.test/data"),
  addresses: [
    { address: "192.0.2.1", family: 4 },
    { address: "192.0.2.2", family: 4 },
  ],
};

function agent() {
  return {
    close: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
  };
}

describe("provider network transport", () => {
  it("tries the next SSRF-approved candidate after an exact connect timeout", async () => {
    const successfulAgent = agent();
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }))
      .mockResolvedValueOnce({ response: new Response('{"ok":true}'), agent: successfulAgent });
    const transport = createProviderNetworkTransport(undefined, { attempt: attempt as never });

    const response = await transport(target, target.url);

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(attempt.mock.calls.map((call) => call[3])).toEqual(target.addresses);
    expect(successfulAgent.close).toHaveBeenCalledOnce();
  });

  it("does not retry TLS or other non-connect failures", async () => {
    const failure = Object.assign(new Error("certificate rejected"), { code: "CERT_HAS_EXPIRED" });
    const attempt = vi.fn().mockRejectedValue(failure);
    const transport = createProviderNetworkTransport(undefined, { attempt: attempt as never });

    await expect(transport(target, target.url)).rejects.toBe(failure);
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("does not retry a mixed aggregate of connect timeout and TLS failure", async () => {
    const failure = new AggregateError([
      Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
      Object.assign(new Error("certificate rejected"), { code: "CERT_HAS_EXPIRED" }),
    ]);
    const attempt = vi.fn().mockRejectedValue(failure);
    const transport = createProviderNetworkTransport(undefined, { attempt: attempt as never });

    await expect(transport(target, target.url)).rejects.toBe(failure);
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("deduplicates and family-interleaves at most four candidates within the 12 second budget", async () => {
    const addresses = [
      { address: "192.0.2.1", family: 4 },
      { address: "192.0.2.1", family: 4 },
      { address: "192.0.2.2", family: 4 },
      { address: "2001:db8::1", family: 6 },
      { address: "192.0.2.3", family: 4 },
      { address: "2001:db8::2", family: 6 },
      { address: "192.0.2.4", family: 4 },
    ];
    const timeout = () => Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    const attempt = vi.fn().mockImplementation(async () => Promise.reject(timeout()));
    const transport = createProviderNetworkTransport(undefined, { attempt: attempt as never });

    await expect(transport({ ...target, addresses }, target.url)).rejects.toMatchObject({
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    expect(attempt.mock.calls.map((call) => call[3])).toEqual([
      { address: "192.0.2.1", family: 4 },
      { address: "2001:db8::1", family: 6 },
      { address: "192.0.2.2", family: 4 },
      { address: "2001:db8::2", family: 6 },
    ]);
    expect(attempt).toHaveBeenCalledTimes(4);
  });

  it("closes the successful dispatcher when the caller cancels the response body", async () => {
    const successfulAgent = agent();
    const attempt = vi.fn().mockResolvedValue({ response: new Response("payload"), agent: successfulAgent });
    const transport = createProviderNetworkTransport(undefined, { attempt: attempt as never });
    const response = await transport(target, target.url);

    await response.body?.cancel();

    expect(successfulAgent.close).toHaveBeenCalledOnce();
  });
});
