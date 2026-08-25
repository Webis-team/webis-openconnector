import type { ProviderDefinition } from "../../core/types.ts";

import { qichachaAgentActions } from "./actions.ts";

/**
 * Qichacha Agent provider backed by the official multi-server MCP platform.
 */
export const provider: ProviderDefinition = {
  service: "qichacha_agent",
  displayName: "Qichacha Agent",
  description:
    "Resolve Chinese companies and query current business registration, risk, intellectual-property, operating, legal, tender, and document data through Qichacha's Agent MCP platform.",
  categories: ["Data", "Finance"],
  authTypes: ["api_key"],
  auth: [
    {
      type: "api_key",
      label: "API Key",
      placeholder: "Paste your Qichacha Agent API Key",
      description:
        "Create or copy an API Key from https://agent.qcc.com/profile/api-key. The runtime sends it as an Authorization Bearer token to the official Qichacha Agent MCP servers.",
    },
  ],
  homepageUrl: "https://agent.qcc.com/",
  actions: qichachaAgentActions,
};
