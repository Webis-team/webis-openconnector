import type { CatalogStore } from "../../catalog-store.ts";
import type { ExecutionContext, ProviderDefinition, CredentialProfile, ResolvedCredential } from "../../core/types.ts";
import type { ExecutorModules } from "../../providers/provider-loader.ts";

import { createCatalogStore } from "../../catalog-store.ts";
import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import { providerFetch } from "../../providers/provider-runtime.ts";

/** Explicit test-environment fixture. It never replaces production provider endpoints. */
export function addTestProviders(
  catalog: CatalogStore,
  modules: ExecutorModules,
  env: Record<string, string | undefined>,
): CatalogStore {
  const origin = env.WEBIS_CONNECTOR_TEST_PROVIDER_ORIGIN;
  if (!origin) return catalog;
  if (env.WEBIS_CONNECTOR_ENVIRONMENT !== "test") throw new Error("Test providers require the test environment.");
  const authorizationUrl = env.WEBIS_CONNECTOR_TEST_AUTHORIZE_URL;
  if (!authorizationUrl) throw new Error("Test provider authorization URL is required.");
  const readAccount = async (token: string, oauth: boolean): Promise<CredentialProfile & { synthetic: boolean }> => {
    const response = await providerFetch(`${origin}${oauth ? "/me" : "/platform"}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error("Test provider rejected the credential.");
    return (await response.json()) as CredentialProfile & { synthetic: boolean };
  };
  const providers: ProviderDefinition[] = [true, false].map((oauth) => {
    const service = oauth ? "webis_test_oauth" : "webis_test_platform";
    const action = defineProviderAction(service, {
      name: "read_account",
      description: "Read the authenticated synthetic account. Use this action to verify which account is executing.",
      inputSchema: s.object({}),
      outputSchema: s.object({ accountId: s.string(), displayName: s.string(), synthetic: s.boolean() }),
    });
    const token = (credential: ResolvedCredential | undefined): string =>
      credential?.authType === "oauth2"
        ? credential.accessToken
        : credential?.authType === "api_key"
          ? credential.apiKey
          : "";
    modules[service] = async () => ({
      executors: {
        [action.id]: async (_input: unknown, context: ExecutionContext) => ({
          ok: true,
          output: await readAccount(token(await context.getCredential(service)), oauth),
        }),
      },
      credentialValidators: oauth
        ? {
            oauth2: async (credential) => ({
              profile: { ...(await readAccount(credential.accessToken, true)), grantedScopes: ["profile:read"] },
            }),
          }
        : { apiKey: async (credential) => ({ profile: await readAccount(credential.apiKey, false) }) },
    });
    return {
      service,
      displayName: oauth ? "Test Personal Account" : "Test Platform Tool",
      categories: ["Development"],
      authTypes: [oauth ? "oauth2" : "api_key"],
      auth: oauth
        ? [
            {
              type: "oauth2",
              authorizationUrl,
              tokenUrl: `${origin}/token`,
              scopes: ["profile:read"],
              tokenEndpointAuthMethod: "client_secret_post",
              pkce: { method: "S256" },
            },
          ]
        : [{ type: "api_key" }],
      actions: [action],
    };
  });
  return createCatalogStore([...catalog.providers, ...providers], {
    executableActionIds: [...catalog.executableActionIds, ...providers.flatMap((p) => p.actions.map((a) => a.id))],
  });
}
