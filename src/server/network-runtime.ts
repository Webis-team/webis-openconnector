import { setDefaultResultOrder } from "node:dns";

/**
 * Prefer the address family that is reachable in the current K3S network while
 * retaining IPv6 fallback. Node's fetch otherwise may spend its whole connect
 * timeout on the first IPv6 candidate returned by a dual-stack provider.
 */
export function configureProviderNetwork(): void {
  setDefaultResultOrder("ipv4first");
}
