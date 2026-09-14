import { afterEach, expect, it } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { ConnectionService } from "../../connection-service.ts";
import { SqliteRuntimeDatabase } from "../storage/sqlite-runtime-store.ts";
import { UserConnectionStore } from "./user-connection-store.ts";

const databases: SqliteRuntimeDatabase[] = [];
afterEach(() => {
  databases.splice(0).forEach((database) => database.close());
});

it("rejects an old execution credential when reauthorization returns the same token", async () => {
  const database = new SqliteRuntimeDatabase(":memory:");
  databases.push(database);
  const store = new UserConnectionStore(database.connectionStore, "user-a");
  const catalog = createCatalogStore([
    {
      service: "example",
      displayName: "Example",
      categories: [],
      authTypes: ["oauth2"],
      auth: [
        {
          type: "oauth2",
          authorizationUrl: "https://example.com/auth",
          tokenUrl: "https://example.com/token",
          tokenEndpointAuthMethod: "client_secret_post",
          scopes: [],
        },
      ],
      actions: [],
    },
  ]);
  const connections = new ConnectionService({
    catalog,
    store,
    recheckExecutionConnection: true,
    providerLoader: {
      loadActionExecutor: async () => undefined,
      loadCredentialValidators: async () => undefined,
      loadProxyExecutor: async () => undefined,
    },
  });
  const credential = {
    authType: "oauth2" as const,
    accessToken: "provider-reuses-token",
    tokenType: "Bearer",
    profile: { accountId: "account", displayName: "Account", grantedScopes: [] },
    metadata: {},
  };
  await store.beginAuthorization("example");
  await store.set("example", "default", credential);
  const execution = await connections.resolveForExecution("example");
  await store.beginAuthorization("example");
  await store.set("example", "default", credential);
  await expect(execution.getCredential("example")).rejects.toMatchObject({ code: "connection_not_found" });
});
