import type { ActionExecutor, ProviderDefinition, ResolvedCredential } from "../../core/types.ts";

import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { OAuthClientConfigService } from "../../oauth/oauth-client-config-service.ts";
import { OAuthCredentialRefreshService } from "../../oauth/oauth-credential-refresh-service.ts";
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
            ? { ok: true, output: { account: resolved.profile.accountId } }
            : { ok: false, error: { code: "missing_credential", message: "Missing credential" } };
        };
      },
      async loadProxyExecutor() {
        return undefined;
      },
      async loadCredentialValidators() {
        return undefined;
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

describe("managed user connector HTTP boundary", () => {
  it("pins personal app configuration across encrypted callback state and credential refresh", async () => {
    const f = await fixture();
    const fetcher = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      Response.json({ access_token: "personal-access", refresh_token: "personal-refresh", token_type: "Bearer" }),
    );
    vi.stubGlobal("fetch", fetcher);
    const start = await f.request(
      "/user/connections/personal/authorize",
      "a",
      {
        method: "POST",
        body: JSON.stringify({ clientConfig: { clientId: "a-app", clientSecret: "a-secret" } }),
      },
      "connections",
    );
    expect(start.status).toBe(200);
    const url = new URL((await start.json()).authorization_url);
    expect(url.searchParams.get("client_id")).toBe("a-app");
    const callback = { state: url.searchParams.get("state"), code: "test-code" };
    await f.db.oauthClientConfigStore.set({
      service: "personal",
      clientId: "platform-changed",
      clientSecret: "platform-secret",
      extra: {},
      secretExtra: {},
    });
    const wrongOwner = await f.request(
      "/user/connections/personal/complete",
      "b",
      { method: "POST", body: JSON.stringify(callback) },
      "connections",
    );
    expect(wrongOwner.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    const complete = await f.request(
      "/user/connections/personal/complete",
      "a",
      { method: "POST", body: JSON.stringify(callback) },
      "connections",
    );
    expect(complete.status).toBe(200);
    const exchange = new URLSearchParams(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(exchange.get("client_id")).toBe("a-app");
    expect(exchange.get("client_secret")).toBe("a-secret");
    const store = new UserConnectionStore(f.db.connectionStore, "a");
    const connected = await store.get("personal", "default");
    if (connected?.credential.authType !== "oauth2") throw new Error("Missing personal credential");
    const refresh = new OAuthCredentialRefreshService(
      new OAuthClientConfigService({
        catalog: f.catalog,
        store: f.db.oauthClientConfigStore,
        origin: identityConfig.publicOrigin,
      }),
    );
    await refresh.refresh("personal", connected.credential);
    const refreshed = new URLSearchParams(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(refreshed.get("client_id")).toBe("a-app");
    expect(refreshed.get("client_secret")).toBe("a-secret");
    expect((await f.db.oauthClientConfigStore.get("personal"))?.clientId).toBe("platform-changed");
    const bDetail = await f.request("/user/connections/personal/configuration", "b", {}, "connections");
    expect((await bDetail.json()).client).toBeNull();
    expect(
      (
        await f.request(
          "/user/connections/personal/complete",
          "a",
          { method: "POST", body: JSON.stringify(callback) },
          "connections",
        )
      ).status,
    ).toBe(400);
  });

  it("prices personal OAuth capabilities without platform configuration or granting users access", async () => {
    const f = await fixture();
    const billing = () => f.app.request("/v1/actions/catalog", { headers: { authorization: "Bearer old-runtime" } });
    const before = await (await billing()).json();
    expect(before.data.items.map((item: { actionId: string }) => item.actionId).sort()).toEqual([
      "legacy.read",
      "personal.read",
      "platform.read",
    ]);
    await f.db.oauthClientConfigStore.set({
      service: "personal",
      clientId: "private-client",
      clientSecret: "private-client-secret",
      extra: {},
      secretExtra: {},
    });
    const priced = await billing();
    expect(priced.status).toBe(200);
    const body = await priced.json();
    expect(body.data.items.map((item: { actionId: string }) => item.actionId).sort()).toEqual([
      "legacy.read",
      "personal.read",
      "platform.read",
    ]);
    const userCatalog = await (await f.request("/v1/actions/catalog")).json();
    expect(userCatalog.data.items.map((item: { actionId: string }) => item.actionId)).toEqual(["platform.read"]);
    expect(
      (await f.request("/v1/actions/personal.read", "a", { method: "POST", body: '{"input":{}}' })).status,
    ).toBeGreaterThanOrEqual(400);
    expect(f.calls()).toBe(0);
    await f.authorize("a", "account-a");
    await f.authorize("b", "account-b");
    expect(await (await billing()).json()).toEqual(body);
    const serialized = JSON.stringify(body);
    for (const secret of ["account-a", "account-b", "token-", "private-client", "private-platform", "__webis_user_"]) {
      expect(serialized).not.toContain(secret);
    }
    await f.db.connectionStore.delete("platform", "default");
    const after = await (await billing()).json();
    expect(after.data.items.map((item: { actionId: string }) => item.actionId).sort()).toEqual([
      "legacy.read",
      "personal.read",
    ]);
    expect((await f.app.request("/v1/actions/catalog")).status).toBe(401);
  });

  it("exposes a stable authorization generation to the Harness MCP connection view", async () => {
    const f = await fixture();
    await f.authorize("a", "account-a");
    const store = new UserConnectionStore(f.db.connectionStore, "a");
    const current = await store.get("personal", "default");
    if (current?.credential.authType !== "oauth2") throw new Error("Missing OAuth fixture");
    const generation = current.credential.metadata.webisAuthorizationGeneration;
    expect(typeof generation).toBe("string");
    const response = await f.request("/mcp", "a", {
      method: "POST",
      headers: { accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "connections",
        method: "tools/call",
        params: { name: "list_connections", arguments: {} },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`"authorizationRevision":"${generation}"`);
  });

  it("uses caller accounts and hides global OAuth and platform account metadata", async () => {
    const f = await fixture();
    await f.authorize("a", "account-a");
    await f.authorize("b", "account-b");
    for (const user of ["a", "b"]) {
      const list = await f.request("/v1/apps", user);
      expect(list.status).toBe(200);
      expect(list.headers.get("cache-control")).toBe("private, no-store");
      const text = await list.text();
      expect(text).toContain(`account-${user}`);
      expect(text).not.toContain(user === "a" ? "account-b" : "account-a");
      expect(text).not.toContain("legacy-account");
      expect(text).not.toContain("private-platform-account");
      expect(text).not.toContain("private-platform-key");
      const run = await f.request("/v1/actions/personal.read", user, {
        method: "POST",
        body: JSON.stringify({ input: {} }),
      });
      expect(run.status).toBe(200);
      expect(await run.text()).toContain(`account-${user}`);
    }
  });

  it("rejects legacy runtime calls and management/execution purpose crossover", async () => {
    const f = await fixture();
    expect(
      (await f.app.request("/mcp", { method: "POST", headers: { authorization: "Bearer old-runtime" } })).status,
    ).toBe(401);
    expect((await f.request("/user/connections")).status).toBe(403);
    expect((await f.request("/v1/apps", "a", {}, "connections")).status).toBe(403);
    expect((await f.request("/api/runs", "a", {}, "connections")).status).toBe(403);
    expect((await f.request("/api/runtime-tokens", "a", { method: "POST", body: "{}" }, "connections")).status).toBe(
      403,
    );
  });

  it("partitions identical idempotency keys between users", async () => {
    const f = await fixture();
    await f.authorize("a", "account-a");
    await f.authorize("b", "account-b");
    const init = { method: "POST", body: JSON.stringify({ input: {} }), headers: { "idempotency-key": "shared-key" } };
    const first = await f.request("/v1/actions/personal.read", "a", init);
    expect(await first.text()).toContain("account-a");
    const second = await f.request("/v1/actions/personal.read", "b", init);
    expect(await second.text()).toContain("account-b");
    await f.request("/v1/actions/personal.read", "a", init);
    expect(f.calls()).toBe(2);
  });

  it("does not redispatch a completed operation when an unrelated authorization changes", async () => {
    const f = await fixture();
    const init = { method: "POST", body: JSON.stringify({ input: {} }), headers: { "idempotency-key": "stable-key" } };
    expect((await f.request("/v1/actions/platform.read", "a", init)).status).toBe(200);
    await f.authorize("a", "new-personal-account");
    await f.request("/v1/actions/platform.read", "a", init);
    expect(f.calls()).toBe(1);
  });

  it("does not replay or redispatch old personal results after replacing or disconnecting an account", async () => {
    const f = await fixture();
    await f.authorize("a", "original-account");
    const init = {
      method: "POST",
      body: JSON.stringify({ input: {} }),
      headers: { "idempotency-key": "personal-key" },
    };
    await f.request("/v1/actions/personal.read", "a", init);
    await f.authorize("a", "replacement-account");
    const replaced = await f.request("/v1/actions/personal.read", "a", init);
    expect(replaced.status).toBeGreaterThanOrEqual(400);
    expect(await replaced.text()).not.toContain("original-account");
    expect(f.calls()).toBe(1);
    await new UserConnectionStore(f.db.connectionStore, "a").delete("personal", "default");
    const disconnected = await f.request("/v1/actions/personal.read", "a", init);
    expect(disconnected.status).toBeGreaterThanOrEqual(400);
    expect(await disconnected.text()).not.toContain("original-account");
    expect(f.calls()).toBe(1);
  });

  it("preserves idempotency across ordinary access-token refresh", async () => {
    const f = await fixture();
    await f.authorize("a", "account-a");
    const init = { method: "POST", body: JSON.stringify({ input: {} }), headers: { "idempotency-key": "refresh-key" } };
    expect((await f.request("/v1/actions/personal.read", "a", init)).status).toBe(200);
    const store = new UserConnectionStore(f.db.connectionStore, "a");
    const current = await store.get("personal", "default");
    if (current?.credential.authType !== "oauth2") throw new Error("Missing OAuth fixture");
    expect(
      await store.updateCredential({
        ...current,
        credential: { ...current.credential, accessToken: "refreshed-token" },
      }),
    ).toBe(true);
    const replay = await f.request("/v1/actions/personal.read", "a", init);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain("account-a");
    expect(f.calls()).toBe(1);
  });

  it("rejects completed personal results after disconnect without affecting another user", async () => {
    const f = await fixture();
    await f.authorize("a", "account-a");
    await f.authorize("b", "account-b");
    const init = {
      method: "POST",
      body: JSON.stringify({ input: {} }),
      headers: { "idempotency-key": "disconnect-key" },
    };
    await f.request("/v1/actions/personal.read", "a", init);
    const disconnected = await f.request("/user/connections/personal", "a", { method: "DELETE" }, "connections");
    expect(disconnected.status).toBe(200);
    const replay = await f.request("/v1/actions/personal.read", "a", init);
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(await replay.text()).not.toContain("account-a");
    expect(f.calls()).toBe(1);
    const other = await f.request("/v1/actions/personal.read", "b", init);
    expect(other.status).toBe(200);
    expect(await other.text()).toContain("account-b");
  });
});
