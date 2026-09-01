import type { GuardedFetchResolvedTransport, ResolvedAddress } from "../core/guarded-fetch.ts";
import type { Logger } from "./logger.ts";

import { Agent, fetch as undiciFetch } from "undici";

const candidateConnectTimeoutMs = 3_000;
const maxCandidates = 4;

interface CandidateAttempt {
  response: Awaited<ReturnType<typeof undiciFetch>>;
  agent: Agent;
}

interface ProviderNetworkTransportOptions {
  attempt?: (
    target: URL,
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    candidate: ResolvedAddress,
  ) => Promise<CandidateAttempt>;
}

export function createProviderNetworkTransport(
  logger?: Logger,
  options: ProviderNetworkTransportOptions = {},
): GuardedFetchResolvedTransport {
  const attempt = options.attempt ?? fetchCandidate;
  return async (target, input, init) => {
    const candidates = boundedCandidates(target.addresses);
    let lastConnectTimeout: unknown;
    for (const [index, candidate] of candidates.entries()) {
      try {
        const { response, agent } = await attempt(target.url, input, init, candidate);
        return closeAgentWithResponse(response, agent);
      } catch (error) {
        if (!isConnectTimeout(error)) {
          throw error;
        }
        lastConnectTimeout = error;
        logger?.warn(
          {
            candidateAttempt: index + 1,
            candidateCount: candidates.length,
            errorCode: "UND_ERR_CONNECT_TIMEOUT",
          },
          "provider network candidate timed out",
        );
      }
    }
    throw lastConnectTimeout ?? new TypeError("provider network request failed");
  };
}

/** Deduplicate DNS answers and alternate address families without reordering within a family. */
function boundedCandidates(addresses: readonly ResolvedAddress[]): ResolvedAddress[] {
  const unique = addresses.filter(
    (candidate, index) =>
      addresses.findIndex((item) => item.family === candidate.family && item.address === candidate.address) === index,
  );
  if (unique.length <= 1) {
    return unique;
  }
  const firstFamily = unique[0]?.family;
  const first = unique.filter((candidate) => candidate.family === firstFamily);
  const other = unique.filter((candidate) => candidate.family !== firstFamily);
  const interleaved: ResolvedAddress[] = [];
  while (interleaved.length < maxCandidates && (first.length > 0 || other.length > 0)) {
    const primary = first.shift();
    if (primary) interleaved.push(primary);
    const secondary = other.shift();
    if (secondary && interleaved.length < maxCandidates) interleaved.push(secondary);
  }
  return interleaved;
}

async function fetchCandidate(
  target: URL,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  candidate: ResolvedAddress,
): Promise<CandidateAttempt> {
  const agent = candidateAgent(candidate);
  try {
    const normalizedInit = requestInit(input, init);
    const response = await undiciFetch(target, {
      ...normalizedInit,
      dispatcher: agent,
      redirect: normalizedInit.redirect ?? "manual",
    } as never);
    return { response, agent };
  } catch (error) {
    await agent.destroy().catch(() => undefined);
    throw error;
  }
}

function candidateAgent(candidate: ResolvedAddress): Agent {
  return new Agent({
    connectTimeout: candidateConnectTimeoutMs,
    connect: {
      lookup(_hostname, _options, callback) {
        callback(null, candidate.address, candidate.family);
      },
    },
  });
}

function requestInit(input: RequestInfo | URL, init?: RequestInit): RequestInit {
  if (!(input instanceof Request)) {
    return init ?? {};
  }
  return {
    cache: init?.cache ?? input.cache,
    credentials: init?.credentials ?? input.credentials,
    method: init?.method ?? input.method,
    headers: init?.headers ?? input.headers,
    integrity: init?.integrity ?? input.integrity,
    keepalive: init?.keepalive ?? input.keepalive,
    mode: init?.mode ?? input.mode,
    redirect: init?.redirect ?? input.redirect,
    referrer: init?.referrer ?? input.referrer,
    referrerPolicy: init?.referrerPolicy ?? input.referrerPolicy,
    signal: init?.signal ?? input.signal,
  };
}

function closeAgentWithResponse(response: Awaited<ReturnType<typeof undiciFetch>>, agent: Agent): Response {
  const responseInit = {
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
  };
  if (!response.body) {
    void agent.close().catch(() => undefined);
    return new Response(null, responseInit);
  }
  const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
  let closed = false;
  const close = async (): Promise<void> => {
    if (!closed) {
      closed = true;
      await agent.close().catch(() => undefined);
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          reader.releaseLock();
          controller.close();
          await close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        reader.releaseLock();
        controller.error(error);
        await agent.destroy().catch(() => undefined);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      reader.releaseLock();
      await close();
    },
  });
  return new Response(body, responseInit);
}

function isConnectTimeout(error: unknown, seen = new Set<unknown>()): boolean {
  if (!error || typeof error !== "object" || seen.has(error)) {
    return false;
  }
  seen.add(error);
  const record = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (record.code === "UND_ERR_CONNECT_TIMEOUT") {
    return true;
  }
  if (Array.isArray(record.errors)) {
    return record.errors.length > 0 && record.errors.every((item) => isConnectTimeout(item, seen));
  }
  return isConnectTimeout(record.cause, seen);
}
