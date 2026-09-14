import type { StoredConnection } from "../../connection-service.ts";
import type { ResolvedCredential } from "../../core/types.ts";

import { afterEach, describe, expect, it } from "vitest";
import { SqliteRuntimeDatabase } from "../storage/sqlite-runtime-store.ts";
import { UserConnectionStore, userConnectionName } from "./user-connection-store.ts";
import { UserOAuthStateStore } from "./user-oauth-state-store.ts";

const databases: SqliteRuntimeDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function database(): SqliteRuntimeDatabase {
  const value = new SqliteRuntimeDatabase(":memory:");
  databases.push(value);
  return value;
}

function oauth(account: string): Extract<ResolvedCredential, { authType: "oauth2" }> {
  return {
    authType: "oauth2",
    accessToken: `token-${account}`,
    tokenType: "Bearer",
    profile: { accountId: account, displayName: account, grantedScopes: [] },
    metadata: {},
  };
}

function accountId(value: StoredConnection | undefined): string | undefined {
  return value && value.credential.authType !== "no_auth" ? value.credential.profile.accountId : undefined;
}

async function authorize(store: UserConnectionStore, account: string, service = "example"): Promise<void> {
  await store.beginAuthorization(service);
  await store.set(service, "default", oauth(account));
}

describe("UserConnectionStore isolation", () => {
  it("isolates same-service personal accounts and never shares legacy OAuth", async () => {
    const db = database();
    const a = new UserConnectionStore(db.connectionStore, "a");
    const b = new UserConnectionStore(db.connectionStore, "b");
    await db.connectionStore.set("legacy", "default", oauth("legacy"));
    await authorize(a, "account-a");
    await authorize(b, "account-b");
    expect((await a.list()).map((value) => accountId(value))).toEqual(["account-a"]);
    expect(accountId(await b.get("example", "default"))).toBe("account-b");
    expect(await a.get("example", userConnectionName("b"))).toBeUndefined();
    await expect(a.delete("example", userConnectionName("b"))).rejects.toMatchObject({ code: "connection_forbidden" });
    await a.delete("example", "default");
    expect(await a.get("example", "default")).toBeUndefined();
    expect(accountId(await b.get("example", "default"))).toBe("account-b");
  });

  it("prefers personal OAuth once without hiding platform access from other users", async () => {
    const db = database();
    await db.connectionStore.set("example", "default", {
      authType: "api_key",
      apiKey: "platform",
      values: { apiKey: "platform" },
      profile: { accountId: "platform", displayName: "Platform", grantedScopes: [] },
      metadata: {},
    });
    const a = new UserConnectionStore(db.connectionStore, "a");
    const b = new UserConnectionStore(db.connectionStore, "b");
    await authorize(a, "personal");
    expect(await a.list()).toHaveLength(1);
    expect((await a.get("example", "default"))?.credential.authType).toBe("oauth2");
    expect((await b.get("example", "default"))?.credential.authType).toBe("api_key");
    await expect(b.set("example", "default", oauth("spoof"))).rejects.toMatchObject({ code: "connection_forbidden" });
    await b.delete("example", "default");
    expect((await db.connectionStore.get("example", "default"))?.credential.authType).toBe("api_key");
  });

  it("does not expose a reserved connection whose owner metadata mismatches", async () => {
    const db = database();
    const credential = oauth("other");
    await db.connectionStore.set("example", userConnectionName("a"), { ...credential, metadata: { webisOwner: "b" } });
    const a = new UserConnectionStore(db.connectionStore, "a");
    expect(await a.list()).toEqual([]);
    expect(await a.get("example", "default")).toBeUndefined();
  });

  it("invalidates stale callbacks across service instances without creating pending credentials", async () => {
    const db = database();
    const old = new UserConnectionStore(db.connectionStore, "a");
    await old.beginAuthorization("example");
    expect(await db.connectionStore.list()).toEqual([]);
    const next = new UserConnectionStore(db.connectionStore, "a");
    await next.beginAuthorization("example");
    await expect(old.set("example", "default", oauth("stale"))).rejects.toMatchObject({
      code: "authorization_superseded",
    });
    await next.set("example", "default", oauth("current"));
    await expect(next.set("example", "default", oauth("replay"))).rejects.toMatchObject({
      code: "authorization_superseded",
    });
    expect(accountId(await next.get("example", "default"))).toBe("current");
  });

  it("preserves existing credentials during authorization and allows refresh before completion", async () => {
    const db = database();
    const a = new UserConnectionStore(db.connectionStore, "a");
    await authorize(a, "original");
    const refreshing = await a.get("example", "default");
    await a.beginAuthorization("example");
    expect(accountId(await a.get("example", "default"))).toBe("original");
    expect(await a.updateCredential({ ...refreshing!, credential: oauth("refreshed") })).toBe(true);
    await a.set("example", "default", oauth("replacement"));
    expect(accountId(await a.get("example", "default"))).toBe("replacement");
  });

  it("does not let either pending authorization or an old refresh recreate a disconnected account", async () => {
    const db = database();
    const a = new UserConnectionStore(db.connectionStore, "a");
    await authorize(a, "original");
    const refreshing = await a.get("example", "default");
    await a.beginAuthorization("example");
    await new UserConnectionStore(db.connectionStore, "a").delete("example", "default");
    expect(await a.updateCredential({ ...refreshing!, credential: oauth("refreshed") })).toBe(false);
    await expect(a.set("example", "default", oauth("callback"))).rejects.toMatchObject({
      code: "authorization_superseded",
    });
    expect(await a.list()).toEqual([]);
  });

  it("does not consume another user's OAuth state and consumes the correct state once", async () => {
    const db = database();
    const a = new UserOAuthStateStore(db.oauthStateStore, new UserConnectionStore(db.connectionStore, "a"));
    const b = new UserOAuthStateStore(db.oauthStateStore, new UserConnectionStore(db.connectionStore, "b"));
    await a.set({ service: "example", state: "opaque-state", createdAt: new Date().toISOString() });
    expect(await b.take("opaque-state")).toBeUndefined();
    const restarted = new UserOAuthStateStore(db.oauthStateStore, new UserConnectionStore(db.connectionStore, "a"));
    expect(await restarted.take("opaque-state")).toMatchObject({ service: "example", state: "opaque-state" });
    expect(await a.take("opaque-state")).toBeUndefined();
  });
});
