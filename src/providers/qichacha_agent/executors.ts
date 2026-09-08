import type { CredentialValidators, ProviderExecutors, ProviderProxyExecutor } from "../../core/types.ts";
import type { ApiKeyProviderContext, ProviderActionHandlers, ProviderRuntimeHandler } from "../provider-runtime.ts";

import { requiredString } from "../../core/cast.ts";
import {
  createProviderFetch,
  defineApiKeyProviderExecutors,
  defineProviderProxy,
  ProviderRequestError,
  providerUserAgent,
} from "../provider-runtime.ts";
import {
  callQichachaAgentTool,
  listQichachaAgentTools,
  qichachaAgentMcpOrigin,
  qichachaAgentMcpPaths,
  qichachaAgentServerDisplayName,
  readQichachaAgentArguments,
  readQichachaAgentServerId,
} from "./runtime.ts";

const service = "qichacha_agent";

const handlers: ProviderActionHandlers<"qichacha_agent", ProviderRuntimeHandler<ApiKeyProviderContext>> = {
  async list_tools(input, context) {
    const serverId = readQichachaAgentServerId(input.serverId);
    const result = await listQichachaAgentTools(serverId, context);
    return {
      serverId,
      displayName: qichachaAgentServerDisplayName(serverId),
      tools: result.tools,
    };
  },
  async call_tool(input, context) {
    return {
      result: await callQichachaAgentTool(
        readQichachaAgentServerId(input.serverId),
        requiredString(input.toolName, "toolName", providerInputError),
        readQichachaAgentArguments(input.arguments),
        context,
      ),
    };
  },
  get_company_by_query(input, context) {
    return callNamedCompanyTool("company", "get_company_by_query", input, context);
  },
  get_company_registration_info(input, context) {
    return callNamedCompanyTool("company", "get_company_registration_info", input, context);
  },
  get_shareholder_info(input, context) {
    return callNamedCompanyTool("company", "get_shareholder_info", input, context);
  },
  get_company_risk_scan(input, context) {
    return callNamedCompanyTool("risk", "get_company_risk_scan", input, context);
  },
  get_dishonest_info(input, context) {
    return callNamedCompanyTool("risk", "get_dishonest_info", input, context);
  },
  get_trademark_info(input, context) {
    return callNamedCompanyTool("ipr", "get_trademark_info", input, context);
  },
  get_bidding_info(input, context) {
    return callNamedCompanyTool("operation", "get_bidding_info", input, context);
  },
};

export const executors: ProviderExecutors = defineApiKeyProviderExecutors(service, handlers, {
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  async apiKey(input, { fetcher, signal }) {
    const context = {
      apiKey: input.apiKey,
      fetcher: createProviderFetch({ fetch: fetcher, skipDnsValidation: true }),
      signal,
    };
    const result = await listQichachaAgentTools("company", context, "validate");
    if (result.tools.length === 0) {
      throw new ProviderRequestError(400, "Qichacha Agent did not expose company tools for this API Key");
    }
    const keyHash = await hashApiKey(input.apiKey);
    return {
      profile: {
        accountId: `qichacha-agent:mcp:${keyHash}`,
        displayName: `Qichacha Agent MCP · ${keyHash.slice(-6)}`,
      },
      grantedScopes: [],
      metadata: {
        mcpOrigin: qichachaAgentMcpOrigin,
        validationServer: "company",
        discoveredToolCount: result.tools.length,
      },
    };
  },
};

const allowedMcpPaths = new Set(Object.values(qichachaAgentMcpPaths));

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  baseUrl: qichachaAgentMcpOrigin,
  auth: { type: "api_key_authorization", prefix: "Bearer " },
  allowedEndpoint: (endpoint) => allowedMcpPaths.has(endpoint),
  customizeRequest({ headers }) {
    if (!headers.has("accept")) headers.set("accept", "application/json, text/event-stream");
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    if (!headers.has("user-agent")) headers.set("user-agent", providerUserAgent);
  },
  skipDnsValidation: true,
});

async function callNamedCompanyTool(
  serverId: "company" | "risk" | "ipr" | "operation",
  toolName: string,
  input: Record<string, unknown>,
  context: ApiKeyProviderContext,
): Promise<{ result: unknown }> {
  const searchKey = requiredString(input.searchKey, "searchKey", providerInputError);
  return { result: await callQichachaAgentTool(serverId, toolName, { searchKey }, context) };
}

async function hashApiKey(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey.trim()));
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function providerInputError(message: string): ProviderRequestError {
  return new ProviderRequestError(400, message);
}
