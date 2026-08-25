import type { ApiKeyProviderContext } from "../provider-runtime.ts";
import type { QichachaAgentServerId } from "./actions.ts";
import type { Client } from "@modelcontextprotocol/client";

import { ProtocolError, SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import { optionalRecord, requiredString } from "../../core/cast.ts";
import { withMcpClient } from "../mcp-client.ts";
import { ProviderRequestError, providerUserAgent } from "../provider-runtime.ts";
import { qichachaAgentServerIds } from "./actions.ts";

export const qichachaAgentMcpOrigin = "https://agent.qcc.com";
export const qichachaAgentMcpPaths: Record<QichachaAgentServerId, string> = {
  company: "/mcp/company/stream",
  risk: "/mcp/risk/stream",
  ipr: "/mcp/ipr/stream",
  operation: "/mcp/operation/stream",
  history: "/mcp/history/stream",
  executive: "/mcp/executive/stream",
  regulation: "/mcp/regulation/stream",
  case: "/mcp/case/stream",
  tender: "/mcp/tender/stream",
  document: "/mcp/document/stream",
};

const serverDisplayNames: Record<QichachaAgentServerId, string> = {
  company: "Company Data",
  risk: "Risk Data",
  ipr: "Intellectual Property",
  operation: "Operations Data",
  history: "Historical Data",
  executive: "Executive Profiles",
  regulation: "Laws and Regulations",
  case: "Judicial Cases",
  tender: "Tender Data",
  document: "Document Parsing",
};

const requestTimeoutMs = 60_000;
type QichachaAgentToolResult = Awaited<ReturnType<Client["callTool"]>>;

/** Discover the live tools exposed by one Qichacha Agent MCP server. */
export async function listQichachaAgentTools(
  serverId: QichachaAgentServerId,
  context: ApiKeyProviderContext,
  phase: "validate" | "execute" = "execute",
): Promise<Awaited<ReturnType<Client["listTools"]>>> {
  return withQichachaAgentClient(serverId, context, phase, (client) =>
    client.listTools({}, { timeout: requestTimeoutMs, signal: context.signal }),
  );
}

/** Call one tool after its arguments have been validated by the public or live schema. */
export async function callQichachaAgentTool(
  serverId: QichachaAgentServerId,
  toolName: string,
  argumentsInput: Record<string, unknown>,
  context: ApiKeyProviderContext,
): Promise<unknown> {
  const result = await withQichachaAgentClient(serverId, context, "execute", (client) =>
    client.callTool(
      { name: toolName, arguments: argumentsInput },
      { timeout: requestTimeoutMs, signal: context.signal },
    ),
  );
  return normalizeQichachaAgentToolResult(toolName, result);
}

/** Validate and normalize a server selector received at a runtime boundary. */
export function readQichachaAgentServerId(value: unknown): QichachaAgentServerId {
  const serverId = requiredString(value, "serverId", providerInputError);
  if (qichachaAgentServerIds.some((candidate) => candidate === serverId)) {
    return serverId as QichachaAgentServerId;
  }
  throw providerInputError(`serverId must be one of ${qichachaAgentServerIds.join(", ")}`);
}

/** Return the catalog label for one official Qichacha MCP server. */
export function qichachaAgentServerDisplayName(serverId: QichachaAgentServerId): string {
  return serverDisplayNames[serverId];
}

function withQichachaAgentClient<T>(
  serverId: QichachaAgentServerId,
  context: ApiKeyProviderContext,
  phase: "validate" | "execute",
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const headers = new Headers({
    authorization: `Bearer ${context.apiKey.trim()}`,
    "user-agent": providerUserAgent,
  });
  return withMcpClient(
    {
      endpoint: new URL(qichachaAgentMcpPaths[serverId], qichachaAgentMcpOrigin),
      transport: "streamable_http",
      fetcher: context.fetcher,
      headers,
      signal: context.signal,
      protocolVersion: "legacy",
      mapError: (error) => mapQichachaAgentMcpError(error, phase),
    },
    run,
  );
}

function normalizeQichachaAgentToolResult(toolName: string, result: QichachaAgentToolResult): unknown {
  if ("toolResult" in result) return result;
  if (result.isError) {
    throw new ProviderRequestError(
      502,
      `Qichacha Agent MCP tool ${toolName} returned an error: ${formatToolContent(result)}`,
      result,
    );
  }
  if (result.structuredContent) return result.structuredContent;

  const textItems = result.content.filter((item) => item.type === "text");
  if (textItems.length === 1) {
    try {
      return JSON.parse(textItems[0]!.text) as unknown;
    } catch {
      return textItems[0]!.text;
    }
  }
  return result;
}

function formatToolContent(result: Extract<QichachaAgentToolResult, { content: unknown }>): string {
  const text = result.content
    .map((item) => {
      if (item.type === "text") return item.text;
      if (item.type === "resource") return "text" in item.resource ? item.resource.text : item.resource.uri;
      if (item.type === "resource_link") return item.uri;
      return item.type;
    })
    .filter(Boolean)
    .join("; ");
  return text.slice(0, 300) || "empty error content";
}

function mapQichachaAgentMcpError(error: unknown, phase: "validate" | "execute"): ProviderRequestError {
  if (error instanceof ProviderRequestError) return error;
  if (error instanceof UnauthorizedError) return credentialError(phase, error);
  if (error instanceof SdkHttpError) {
    const status = error.status;
    if (status === 401 || status === 403) return credentialError(phase, error);
    if (status === 429) return new ProviderRequestError(429, "Qichacha Agent MCP request was rate limited", error);
    return new ProviderRequestError(
      status && status >= 400 && status < 500 ? 400 : 502,
      `Qichacha Agent MCP request failed: ${error.message}`,
      error,
    );
  }
  if (error instanceof ProtocolError) {
    return new ProviderRequestError(502, `Qichacha Agent MCP request failed: ${error.message}`, error);
  }
  return new ProviderRequestError(
    502,
    error instanceof Error
      ? `Qichacha Agent MCP request failed: ${error.message}`
      : "Qichacha Agent MCP request failed",
    error,
  );
}

function credentialError(phase: "validate" | "execute", details: unknown): ProviderRequestError {
  return new ProviderRequestError(
    phase === "validate" ? 400 : 401,
    "Qichacha Agent API Key is invalid, expired, or cannot access the selected MCP server",
    details,
  );
}

function providerInputError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}

export function readQichachaAgentArguments(value: unknown): Record<string, unknown> {
  return optionalRecord(value) ?? {};
}
