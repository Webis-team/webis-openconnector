import type { ProviderDefinition } from "../../core/types.ts";

import { afterEach, describe, expect, it } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { OAuthClientConfigService } from "../../oauth/oauth-client-config-service.ts";
import { SqliteRuntimeDatabase } from "../storage/sqlite-runtime-store.ts";
import { PersonalOAuthConfig } from "./personal-oauth-config.ts";
import { UserConnectionStore } from "./user-connection-store.ts";

const databases: SqliteRuntimeDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const provider: ProviderDefinition = {
  service: "example",
  displayName: "Example",
  categories: [],
  authTypes: ["oauth2"],
  actions: [],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://example.com/auth",
      tokenUrl: "https://example.com/token",
      tokenEndpointAuthMethod: "client_secret_post",
      scopes: ["read"],
      clientConfigFields: [
        { key: "legacySecret", label: "Legacy secret", location: "extra", inputType: "password", required: false, secret: true },
        { key: "tenant", label: "Tenant", location: "extra", inputType: "text", required: false, secret: false },
        {
          key: "appSecret",
          label: "App secret",
          location: "secretExtra",
          inputType: "password",
          required: false,
          secret: true,
        },
      ],
    },
  ],
};
const saved = {
  service: "example",
  clientId: "client-a",
  clientSecret: "secret-a",
  extra: { tenant: "tenant-a", legacySecret: "legacy-hidden-a" },
  secretExtra: { appSecret: "extra-secret-a" },
  requestedScopes: ["read"],
};

async function fixture() {
  const db = new SqliteRuntimeDatabase(":memory:");
  databases.push(db);
  const catalog = createCatalogStore([provider]);
  const configs = new OAuthClientConfigService({
    catalog,
    store: db.oauthClientConfigStore,
    origin: "https://webis.test",
  });
  const a = new UserConnectionStore(db.connectionStore, "a");
  const b = new UserConnectionStore(db.connectionStore, "b");
  await a.beginAuthorization("example");
  await a.set("example", "default", {
    authType: "oauth2",
    accessToken: "access-a",
    tokenType: "Bearer",
    profile: { accountId: "a", displayName: "A", grantedScopes: ["read"] },
    metadata: { oauthClientConfig: saved },
  });
  return {
    db,
    a,
    b,
    configs,
    personalA: new PersonalOAuthConfig({ catalog, configs, connections: a }),
    personalB: new PersonalOAuthConfig({ catalog, configs, connections: b }),
  };
}

describe("personal OAuth configuration", () => {
  it("returns only the owner's safe configuration and never exposes a platform app", async () => {
    const f = await fixture();
    await f.db.oauthClientConfigStore.set({ ...saved, clientId: "platform-client", clientSecret: "platform-secret" });
    const detail = await f.personalA.detail("example");
    expect(detail.client).toMatchObject({
      clientId: "client-a",
      extra: { tenant: "tenant-a" },
      secret_present: true,
      secret_extra_present: expect.arrayContaining(["appSecret", "legacySecret"]),
    });
    const other = await f.personalB.detail("example");
    expect(other.client).toBeNull();
    expect(other.platform_configured).toBe(true);
    for (const secret of ["secret-a", "extra-secret-a", "legacy-hidden-a", "access-a", "platform-secret", "platform-client"]) {
      expect(JSON.stringify([detail, other])).not.toContain(secret);
    }
    expect(await f.personalB.authorizationConfig("example")).toBeUndefined();
  });

  it("reuses the same owner's secret only for the same client ID", async () => {
    const f = await fixture();
    const result = await f.personalA.authorizationConfig("example", {
      clientId: " client-a ",
      clientSecret: "",
      extra: { tenant: "tenant-a" },
      secretExtra: { appSecret: "" },
    });
    expect(result).toMatchObject({
      clientId: "client-a",
      clientSecret: "secret-a",
      secretExtra: { appSecret: "extra-secret-a" },
    });
    await expect(
      f.personalA.authorizationConfig("example", { clientId: "client-b", clientSecret: "" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      f.personalB.authorizationConfig("example", { clientId: "client-a", clientSecret: "" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("does not carry secret extra fields into a different app", async () => {
    const f = await fixture();
    const result = await f.personalA.authorizationConfig("example", { clientId: "client-b", clientSecret: "secret-b" });
    expect(result?.clientSecret).toBe("secret-b");
    expect(JSON.stringify(result)).not.toContain("extra-secret-a");
    expect(JSON.stringify(result)).not.toContain("legacy-hidden-a");
  });

  it("keeps successful credentials and generation unchanged on invalid or uncompleted configuration", async () => {
    const f = await fixture();
    const before = await f.a.get("example", "default");
    await expect(f.personalA.authorizationConfig("example", { clientId: "", clientSecret: "" })).rejects.toThrow();
    await f.personalA.authorizationConfig("example", { clientId: "next", clientSecret: "next-secret" });
    expect(await f.a.get("example", "default")).toEqual(before);
    expect(await f.db.oauthClientConfigStore.list()).toEqual([]);
  });

  it("selects the credential snapshot independently of later platform changes", async () => {
    const f = await fixture();
    await f.db.oauthClientConfigStore.set({ ...saved, clientId: "new-platform", clientSecret: "new-secret" });
    expect(await f.personalA.authorizationConfig("example")).toEqual(saved);
    await f.db.oauthClientConfigStore.delete("example");
    expect(await f.personalA.authorizationConfig("example")).toEqual(saved);
    await f.a.delete("example", "default");
    expect(await f.personalA.authorizationConfig("example")).toBeUndefined();
    expect((await f.personalA.detail("example")).client).toBeNull();
  });
});
