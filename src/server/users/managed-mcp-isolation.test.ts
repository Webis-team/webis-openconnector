import type { ActionExecutor, ProviderDefinition, ResolvedCredential } from "../../core/types.ts";

import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { createConnectApp } from "../connect-app.ts";
import { TransitFileService } from "../files/transit-files.ts";
import { AesGcmSecretCodec } from "../secrets/secret-codec.ts";
import { SqliteRuntimeDatabase } from "../storage/sqlite-runtime-store.ts";
import { UserConnectionStore } from "./user-connection-store.ts";

const databases: SqliteRuntimeDatabase[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) db.close();
});
const identityConfig = {
  secret: "test-only-connector-user-secret",
  issuer: "gateway",
  audience: "connector",
  publicOrigin: "http://webis.test",
};

function provider(service: string, auth: "oauth2" | "api_key"): ProviderDefinition {
  return {
    service,
    displayName: service,
    categories: [],
    authTypes: [auth],
    auth:
      auth === "api_key"
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
    actions: [
      {
        id: `${service}.read`,
        service,
        name: "read",
        description: "Read account",
        requiredScopes: [],
        providerPermissions: [],
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      },
    ],
  };
}

function credential(account: string): ResolvedCredential {
  return {
    authType: "oauth2",
    accessToken: `token-${account}`,
    tokenType: "Bearer",
    profile: { accountId: account, displayName: account, grantedScopes: [] },
    metadata: {},
  };
}

async function sign(user: string, purpose = "execution"): Promise<string> {
  return new SignJWT({ purpose, execution_id: `execution-${user}` })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user)
    .setIssuer(identityConfig.issuer)
    .setAudience(identityConfig.audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(identityConfig.secret));
}

async function fixture() {
  const secretCodec = new AesGcmSecretCodec("managed-test-only-encryption-key");
  const db = new SqliteRuntimeDatabase(":memory:", { secretCodec });
  databases.push(db);
  const catalog = createCatalogStore(
    [provider("personal", "oauth2"), provider("platform", "api_key"), provider("legacy", "oauth2")],
    { executableActionIds: ["personal.read", "platform.read", "legacy.read"] },
  );
  await db.connectionStore.set("legacy", "default", credential("legacy-account"));
  await db.connectionStore.set("platform", "default", {
    authType: "api_key",
    apiKey: "private-platform-key",
    values: { apiKey: "private-platform-key" },
    profile: { accountId: "private-platform-account", displayName: "Private Platform Owner", grantedScopes: [] },
    metadata: {},
  });
  let calls = 0;
  const { app } = await createConnectApp({
    catalog,
    runtimeDatabase: db,
    publicOrigin: "http://connector.test",
    secretCodec,
    managedUsers: identityConfig,
    adminToken: "test-admin",
    runtimeToken: "old-runtime",
    transitFiles: new TransitFileService({
      rootDir: "/tmp/web-387-unused-review-files",
      publicOrigin: "http://connector.test",
      ttlSeconds: 60,
      maxBytes: 1024,
    }),
    providerLoader: {
      async loadActionExecutor(service): Promise<ActionExecutor> {
        return async (_input, context) => {
          calls++;
          const resolved = await context.getCredential(service);
          return resolved && resolved.authType !== "no_auth"
            ? {
                ok: true,
                output: {
                  account:
                    resolved.authType === "oauth2" ? resolved.accessToken.replace("token-", "") : "platform-account",
                },
              }
            : { ok: false, error: { code: "missing_credential", message: "Missing credential" } };
        };
      },
      async loadProxyExecutor() {
        return undefined;
      },
      async loadCredentialValidators() {
        return {
          oauth2: async (value: Extract<ResolvedCredential, { authType: "oauth2" }>) => ({
            profile: {
              accountId: value.accessToken.replace("token-", ""),
              displayName: value.accessToken.replace("token-", ""),
              grantedScopes: [],
            },
          }),
        };
      },
    },
  });
  async function authorize(user: string, account: string) {
    const store = new UserConnectionStore(db.connectionStore, user);
    await store.beginAuthorization("personal");
    await store.set("personal", "default", credential(account));
  }
  async function request(path: string, user = "a", init: RequestInit = {}, purpose = "execution") {
    return app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${await sign(user, purpose)}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
  }
  return { app, db, catalog, request, authorize, calls: () => calls };
}

describe("managed MCP discovery and account selection", () => {
  it("isolates A-only discovery and execution, then selects B's own OAuth account", async () => {
    const f = await fixture();
    const refreshed: Array<{ clientId: string | null; account: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body));
        const isRefresh = body.get("grant_type") === "refresh_token";
        const account = isRefresh ? body.get("refresh_token")!.replace("refresh-", "") : body.get("code")!;
        const owner = account === "account-a" ? "a" : "b";
        if (body.get("client_id") !== `app-${owner}` || body.get("client_secret") !== `secret-${owner}`)
          return Response.json({ error: "invalid_client" }, { status: 401 });
        if (isRefresh) refreshed.push({ clientId: body.get("client_id"), account });
        return Response.json({
          access_token: `token-${account}`,
          refresh_token: `refresh-${account}`,
          token_type: "Bearer",
          expires_in: isRefresh ? 3600 : 1,
        });
      }),
    );
    async function authorize(user: string, account: string) {
      const response = await f.request(
        "/user/connections/personal/authorize",
        user,
        {
          method: "POST",
          body: JSON.stringify({ clientConfig: { clientId: `app-${user}`, clientSecret: `secret-${user}` } }),
        },
        "connections",
      );
      expect(response.status).toBe(200);
      const url = new URL((await response.json()).authorization_url);
      const completed = await f.request(
        "/user/connections/personal/complete",
        user,
        {
          method: "POST",
          body: JSON.stringify({ state: url.searchParams.get("state"), code: account }),
        },
        "connections",
      );
      expect(completed.status).toBe(200);
    }
    async function rpc(user: string, name: string, args: Record<string, unknown> = {}) {
      const response = await f.request("/mcp", user, {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "Idempotency-Key": "same-for-a-and-b" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      const event = text.startsWith("{")
        ? text
        : text
            .split("\n")
            .find((line) => line.startsWith("data: "))!
            .slice(6);
      const payload = JSON.parse(event).result.structuredContent;
      for (const secret of [
        "__webis_user_",
        "token-account",
        "refresh-account",
        "secret-a",
        "secret-b",
        "private-platform",
        "legacy-account",
      ]) {
        expect(JSON.stringify(payload)).not.toContain(secret);
      }
      return payload;
    }
    const discovery = [
      { name: "list_apps", args: {} },
      { name: "list_connections", args: {} },
      { name: "search_actions", args: { service: "personal" } },
    ];
    await authorize("a", "account-a");
    for (const tool of discovery) {
      const a = await rpc("a", tool.name, tool.args);
      const b = await rpc("b", tool.name, tool.args);
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      expect(JSON.stringify(a.data)).toContain("personal");
      if (tool.name !== "search_actions") expect(JSON.stringify(a.data)).toContain("account-a");
      expect(JSON.stringify(b.data)).not.toContain("personal");
      expect(JSON.stringify(b)).not.toContain("account-a");
    }
    const aGuide = await rpc("a", "get_action_guide", { actionId: "personal.read" });
    expect(aGuide.ok).toBe(true);
    for (const name of ["get_action_guide", "execute_action"]) {
      const result = await rpc("b", name, { actionId: "personal.read", input: {} });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("unknown_action");
      expect(JSON.stringify(result)).not.toContain("account-a");
    }
    expect(f.calls()).toBe(0);
    const first = await rpc("a", "execute_action", { actionId: "personal.read", input: {} });
    expect(first.ok).toBe(true);
    expect(first.data.account).toBe("account-a");
    await authorize("b", "account-b");
    for (const user of ["a", "b"]) {
      for (const tool of discovery) {
        const payload = await rpc(user, tool.name, tool.args);
        expect(payload.ok).toBe(true);
        expect(JSON.stringify(payload.data)).toContain("personal");
        expect(JSON.stringify(payload)).not.toContain(user === "a" ? "account-b" : "account-a");
      }
      const result = await rpc(user, "execute_action", { actionId: "personal.read", input: {} });
      expect(result.ok).toBe(true);
      expect(result.data.account).toBe(`account-${user}`);
    }
    const disconnected = await f.request("/user/connections/personal", "a", { method: "DELETE" }, "connections");
    expect(disconnected.status).toBe(200);
    expect((await rpc("a", "execute_action", { actionId: "personal.read", input: {} })).ok).toBe(false);
    expect((await rpc("b", "execute_action", { actionId: "personal.read", input: {} })).data.account).toBe("account-b");
    expect((await rpc("a", "execute_action", { actionId: "legacy.read", input: {} })).ok).toBe(false);
    expect(f.calls()).toBe(4);
    expect(refreshed).toEqual(
      expect.arrayContaining([
        { clientId: "app-a", account: "account-a" },
        { clientId: "app-b", account: "account-b" },
      ]),
    );
  });

  it("rejects absent identities and legacy runtime credentials before MCP discovery", async () => {
    const f = await fixture();
    for (const token of [undefined, "old-runtime"]) {
      const response = await f.app.request("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("personal");
    }
    expect(f.calls()).toBe(0);
  });
});
