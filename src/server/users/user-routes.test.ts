import type { ProviderDefinition, ResolvedCredential } from "../../core/types.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { ConnectionError, ConnectionService } from "../../connection-service.ts";
import { OAuthClientConfigService } from "../../oauth/oauth-client-config-service.ts";
import { OAuthFlowService } from "../../oauth/oauth-flow-service.ts";
import { SqliteRuntimeDatabase } from "../storage/sqlite-runtime-store.ts";
import { UserConnectionStore } from "./user-connection-store.ts";
import { createUserRoutes } from "./user-routes.ts";

const databases: SqliteRuntimeDatabase[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

function provider(service: string, authType: "oauth2" | "api_key" = "oauth2"): ProviderDefinition {
  return {
    service,
    displayName: service,
    categories: [],
    authTypes: [authType],
    auth:
      authType === "api_key"
        ? [{ type: "api_key" }]
        : [
            {
              type: "oauth2",
              authorizationUrl: "https://example.com/authorize",
              tokenUrl: "https://example.com/token",
              tokenEndpointAuthMethod: "client_secret_post",
              scopes: [],
            },
          ],
    actions: [],
  };
}

function credential(account: string): ResolvedCredential {
  return {
    authType: "oauth2",
    accessToken: `secret-token-${account}`,
    tokenType: "Bearer",
    profile: { accountId: account, displayName: account, grantedScopes: ["read"] },
    metadata: {},
  };
}

async function fixture() {
  const db = new SqliteRuntimeDatabase(":memory:");
  databases.push(db);
  const catalog = createCatalogStore([
    ...Array.from({ length: 100 }, (_, i) => provider(`provider-${i}`)),
    provider("platform", "api_key"),
  ]);
  await db.oauthClientConfigStore.set({
    service: "provider-0",
    clientId: "private-client-id",
    clientSecret: "private-client-secret",
    extra: {},
    secretExtra: {},
  });
  await db.connectionStore.set("platform", "default", {
    authType: "api_key",
    apiKey: "private-platform-key",
    values: { apiKey: "private-platform-key" },
    profile: { accountId: "platform-owner", displayName: "Platform owner", grantedScopes: [] },
    metadata: {},
  });
  await db.connectionStore.set("provider-2", "default", credential("legacy-account"));
  const configs = new OAuthClientConfigService({
    catalog,
    store: db.oauthClientConfigStore,
    origin: "https://connector.test",
  });
  function user(userId: string) {
    const store = new UserConnectionStore(db.connectionStore, userId);
    const connections = new ConnectionService({
      catalog,
      store,
      hidePlatformProfiles: true,
      providerLoader: {
        async loadActionExecutor() {
          return undefined;
        },
        async loadProxyExecutor() {
          return undefined;
        },
        async loadCredentialValidators() {
          return undefined;
        },
      },
    });
    const oauth = new OAuthFlowService({ clientConfigs: configs, connections, states: db.oauthStateStore });
    return {
      store,
      connections,
      app: createUserRoutes({ catalog, connections, configs, oauth, identity: { userId, purpose: "connections" } }),
    };
  }
  async function authorize(userId: string, account: string, service = "provider-0") {
    const { store } = user(userId);
    await store.beginAuthorization(service);
    await store.set(service, "default", credential(account));
  }
  return { db, user, authorize };
}

describe("personal connection routes", () => {
  it("reads one batch per request across 100 providers and isolates accounts without exposing secrets", async () => {
    const f = await fixture();
    await f.authorize("a", "account-a");
    await f.authorize("b", "account-b");
    await f.authorize("a", "account-without-config", "provider-1");
    const lists = vi.spyOn(f.db.connectionStore, "list");
    const configLists = vi.spyOn(f.db.oauthClientConfigStore, "list");
    const configGets = vi.spyOn(f.db.oauthClientConfigStore, "get");
    for (const userId of ["a", "b"]) {
      const response = await f.user(userId).app.request("/user/connections");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.connections).toHaveLength(100);
      expect(body.connections).toContainEqual({
        service: "provider-0",
        display_name: "provider-0",
        description: "",
        configured: true,
        status: "connected",
        account: { account_id: `account-${userId}`, display_name: `account-${userId}`, granted_scopes: ["read"] },
      });
      expect(body.connections).toContainEqual(
        expect.objectContaining({
          service: "provider-1",
          configured: false,
          status: userId === "a" ? "connected" : "unavailable",
        }),
      );
      expect(body.connections).toContainEqual(
        expect.objectContaining({ service: "provider-2", status: "unavailable", account: null }),
      );
      expect(JSON.stringify(body)).not.toMatch(/secret|private-|legacy-account|platform-owner/);
      expect(JSON.stringify(body)).not.toContain(userId === "a" ? "account-b" : "account-a");
    }
    expect(lists).toHaveBeenCalledTimes(2);
    expect(configLists).toHaveBeenCalledTimes(2);
    expect(configGets).not.toHaveBeenCalled();
    const anonymousAccount = await f.user("c").app.request("/user/connections");
    expect((await anonymousAccount.json()).connections).toContainEqual(
      expect.objectContaining({ service: "provider-0", status: "not_connected", account: null }),
    );
  });

  it("preserves check outcomes and only disconnects the current user's account", async () => {
    const f = await fixture();
    await f.authorize("a", "account-a");
    await f.authorize("b", "account-b");
    const a = f.user("a");
    const check = vi.spyOn(a.connections, "checkOAuthCredential");
    for (const [code, status] of [
      ["oauth_token_expired", "reauthorization_required"],
      ["upstream_error", "check_failed"],
    ]) {
      check.mockRejectedValueOnce(new ConnectionError(code, "secret detail"));
      const response = await a.app.request("/user/connections/provider-0/check", { method: "POST" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status,
        account: { account_id: "account-a" },
        checked_at: expect.any(String),
      });
    }
    check.mockResolvedValueOnce(false);
    expect(await (await a.app.request("/user/connections/provider-0/check", { method: "POST" })).json()).toMatchObject({
      status: "status_unknown",
    });
    expect((await a.app.request("/user/connections/provider-0", { method: "DELETE" })).status).toBe(200);
    expect(await a.store.get("provider-0", "default")).toBeUndefined();
    expect(await f.user("b").store.get("provider-0", "default")).toBeDefined();
    expect(await f.db.connectionStore.get("platform", "default")).toBeDefined();
    const tools = await (await a.app.request("/user/platform-tools")).json();
    expect(tools).toEqual({ tools: [{ service: "platform", display_name: "platform", auth_type: "api_key" }] });
    for (const [path, method] of [
      ["unknown/check", "POST"],
      ["unknown", "DELETE"],
      ["platform", "DELETE"],
    ]) {
      const response = await a.app.request(`/user/connections/${path}`, { method });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "connection_request_failed" });
    }
  });
});
