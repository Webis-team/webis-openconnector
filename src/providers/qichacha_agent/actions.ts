import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";

const service = "qichacha_agent";

export type QichachaAgentServerId =
  | "company"
  | "risk"
  | "ipr"
  | "operation"
  | "history"
  | "executive"
  | "regulation"
  | "case"
  | "tender"
  | "document";

export const qichachaAgentServerIds: readonly QichachaAgentServerId[] = [
  "company",
  "risk",
  "ipr",
  "operation",
  "history",
  "executive",
  "regulation",
  "case",
  "tender",
  "document",
];

const serverIdSchema = s.stringEnum(
  "The Qichacha Agent MCP server to inspect or call. The history server requires enterprise verification.",
  qichachaAgentServerIds,
);

const toolAnnotationsSchema = s.looseObject("MCP hints supplied by Qichacha about a tool's behavior.", {
  title: s.optional(s.string("A human-readable title for the tool.")),
  readOnlyHint: s.optional(s.boolean("Whether the tool is expected not to modify data.")),
  destructiveHint: s.optional(s.boolean("Whether the tool may perform destructive operations.")),
  idempotentHint: s.optional(s.boolean("Whether repeated calls are expected to be idempotent.")),
  openWorldHint: s.optional(s.boolean("Whether the tool may interact with entities outside Qichacha.")),
});

const toolSchema = s.object(
  "A tool currently exposed by one Qichacha Agent MCP server.",
  {
    name: s.nonEmptyString("The exact Qichacha MCP tool name to pass to call_tool."),
    description: s.optional(s.string("The current tool description supplied by Qichacha.")),
    annotations: s.optional(toolAnnotationsSchema),
    inputSchema: s.looseObject("The current JSON Schema for the tool arguments, supplied by Qichacha MCP."),
    outputSchema: s.optional(
      s.looseObject("The current JSON Schema for structured tool output, when supplied by Qichacha MCP."),
    ),
  },
  { optional: ["description", "annotations", "outputSchema"] },
);

const companyQueryInputSchema = s.object("A fuzzy Qichacha company identity lookup.", {
  searchKey: s.nonWhitespaceString(
    "A company name, abbreviation, stock abbreviation, or unified social credit code used to find candidates.",
  ),
});

const companyInputSchema = s.object("An exact Qichacha company lookup.", {
  searchKey: s.nonWhitespaceString("The complete company name or 18-character unified social credit code."),
});

const toolResultSchema = s.object("The normalized result returned by a Qichacha MCP tool.", {
  result: s.unknown("Structured tool output, parsed JSON or text content, or the original MCP content envelope."),
});

export const qichachaAgentActions: readonly ActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_tools",
    description:
      "Discover the current tools and live input schemas exposed by one of the ten Qichacha Agent MCP servers.",
    followUpActions: ["qichacha_agent.call_tool"],
    inputSchema: s.object("Input for discovering one Qichacha Agent MCP server.", {
      serverId: serverIdSchema,
    }),
    outputSchema: s.object("The current Qichacha MCP tool catalog for one server.", {
      serverId: serverIdSchema,
      displayName: s.string("The official display name of the selected Qichacha MCP server."),
      tools: s.array("Tools currently exposed by the selected Qichacha server.", toolSchema),
    }),
  }),
  defineProviderAction(service, {
    name: "call_tool",
    description:
      "Call a current Qichacha Agent MCP tool with JSON arguments after checking its live schema with list_tools.",
    followUpActions: ["qichacha_agent.list_tools"],
    inputSchema: s.object(
      "Input for invoking one current Qichacha MCP tool.",
      {
        serverId: serverIdSchema,
        toolName: s.nonEmptyString("The exact tool name returned by list_tools."),
        arguments: s.optional(s.looseObject("JSON arguments matching the selected tool's inputSchema.")),
      },
      { optional: ["arguments"] },
    ),
    outputSchema: toolResultSchema,
  }),
  defineProviderAction(service, {
    name: "get_company_by_query",
    description:
      "Resolve a company abbreviation, stock abbreviation, or incomplete name to Qichacha's top company candidates before deeper queries.",
    followUpActions: ["qichacha_agent.get_company_registration_info"],
    inputSchema: companyQueryInputSchema,
    outputSchema: toolResultSchema,
  }),
  defineProviderAction(service, {
    name: "get_company_registration_info",
    description:
      "Get current Qichacha business-registration facts for an exactly identified company or unified social credit code.",
    followUpActions: ["qichacha_agent.get_shareholder_info", "qichacha_agent.get_company_risk_scan"],
    inputSchema: companyInputSchema,
    outputSchema: toolResultSchema,
  }),
  defineProviderAction(service, {
    name: "get_shareholder_info",
    description: "Get current registered shareholders and ownership information for an exactly identified company.",
    inputSchema: companyInputSchema,
    outputSchema: toolResultSchema,
  }),
  defineProviderAction(service, {
    name: "get_company_risk_scan",
    description:
      "Scan a company across Qichacha risk factors such as dishonesty, enforcement, judgments, penalties, and equity freezes.",
    followUpActions: ["qichacha_agent.get_dishonest_info"],
    inputSchema: companyInputSchema,
    outputSchema: toolResultSchema,
  }),
  defineProviderAction(service, {
    name: "get_dishonest_info",
    description:
      "Get dishonesty enforcement records for an exactly identified company, including court, filing, publication, and amount details.",
    inputSchema: companyInputSchema,
    outputSchema: toolResultSchema,
  }),
  defineProviderAction(service, {
    name: "get_trademark_info",
    description: "Get Qichacha trademark records for an exactly identified company for brand and IP due diligence.",
    inputSchema: companyInputSchema,
    outputSchema: toolResultSchema,
  }),
  defineProviderAction(service, {
    name: "get_bidding_info",
    description:
      "Get Qichacha tender and bidding participation records for an exactly identified company, including projects, counterparties, outcomes, and amounts when disclosed.",
    inputSchema: companyInputSchema,
    outputSchema: toolResultSchema,
  }),
];
