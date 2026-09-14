import type { ConnectAppOptions } from "../connect-app.ts";
import type { UserIdentityConfig } from "./user-identity.ts";
import type { Hono } from "hono";

import { Hono as HonoApp } from "hono";
import { createHash } from "node:crypto";
import { createCatalogStore } from "../../catalog-store.ts";
import { ConnectionService } from "../../connection-service.ts";
import { OAuthClientConfigService } from "../../oauth/oauth-client-config-service.ts";
import { OAuthCredentialRefreshService } from "../../oauth/oauth-credential-refresh-service.ts";
import { OAuthFlowService } from "../../oauth/oauth-flow-service.ts";
import { ActionRunner } from "../actions/action-runner.ts";
import { ConnectServer } from "../connect-server.ts";
import { RuntimeTokenService } from "../storage/runtime-token-service.ts";
import { PersonalOAuthConfig } from "./personal-oauth-config.ts";
import { UserConnectionStore } from "./user-connection-store.ts";
import { verifyUserIdentity } from "./user-identity.ts";
import { UserOAuthStateStore } from "./user-oauth-state-store.ts";
import { createUserRoutes } from "./user-routes.ts";

export interface ManagedUserConfig extends UserIdentityConfig {
  publicOrigin: string;
}

/** Managed requests get independent services; mutable user state is never shared across requests. */
export function createManagedApp(options: ConnectAppOptions, config: ManagedUserConfig, adminApp: Hono): Hono {
  if (!config.secret || !config.issuer || !config.audience || !options.adminToken)
    throw new Error("Managed user authentication requires signing configuration and an admin token.");
  const app = new HonoApp();
  app.use("*", async (c) => {
    const path = c.req.path;
    if (path === "/health") return adminApp.fetch(c.req.raw);
    if (path.startsWith("/oauth/callback")) return c.json({ error: "use_webis_oauth_callback" }, 403);
    const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const identity = await verifyUserIdentity(token, config);
    if (!identity) {
      // Billing's configured service credential can only read the price catalog.
      const catalog = path === "/v1/actions/catalog" || path === "/v1/actions/catalog/services";
      if (path.startsWith("/user/") || path === "/mcp" || (path.startsWith("/v1/") && !catalog))
        return c.json({ error: "user_identity_required" }, 401);
      return adminApp.fetch(c.req.raw);
    }
    const management = path.startsWith("/user/");
    if (
      (management && identity.purpose !== "connections") ||
      (!management && (identity.purpose !== "execution" || !(path === "/mcp" || path.startsWith("/v1/"))))
    )
      return c.json({ error: "invalid_identity_purpose" }, 403);
    const store = new UserConnectionStore(options.runtimeDatabase.connectionStore, identity.userId);
    const configs = new OAuthClientConfigService({
      catalog: options.catalog,
      store: options.runtimeDatabase.oauthClientConfigStore,
      origin: config.publicOrigin,
      callbackPath: (service) => `/oauth/callback/${encodeURIComponent(service)}`,
    });
    const connections = new ConnectionService({
      catalog: options.catalog,
      store,
      providerLoader: options.providerLoader,
      oauthCredentials: new OAuthCredentialRefreshService(configs),
      logger: options.logger,
      hidePlatformProfiles: true,
      recheckExecutionConnection: true,
    });
    let response: Response;
    if (management) {
      const oauth = new OAuthFlowService({
        clientConfigs: configs,
        connections,
        states: new UserOAuthStateStore(options.runtimeDatabase.oauthStateStore, store),
        secretCodec: options.secretCodec,
        isCustomClientConfigAllowed: () => true,
      });
      response = await createUserRoutes({
        personalConfig: new PersonalOAuthConfig({ catalog: options.catalog, configs, connections: store }),
        catalog: options.catalog,
        connections,
        configs,
        oauth,
        identity,
        logger: options.logger,
      }).fetch(c.req.raw);
    } else {
      const visible = await connections.listConnections();
      const services = new Set(visible.map((connection) => connection.service));
      const catalog = createCatalogStore(
        options.catalog.providers.filter((provider) => services.has(provider.service)),
        { executableActionIds: options.catalog.executableActionIds },
      );
      const partition = createHash("sha256").update(`${identity.userId}:${identity.executionId}`).digest("hex");
      const actions = new ActionRunner({
        catalog,
        connections,
        providerLoader: options.providerLoader,
        runs: options.runtimeDatabase.runLogStore,
        transitFiles: options.transitFiles,
        actionPolicy: options.actionPolicy,
        logger: options.logger,
      });
      const server = new ConnectServer({
        catalog,
        connections,
        actions,
        providerLoader: options.providerLoader,
        oauthClientConfigs: configs,
        oauthFlow: new OAuthFlowService({
          clientConfigs: configs,
          connections,
          states: new UserOAuthStateStore(options.runtimeDatabase.oauthStateStore, store),
          secretCodec: options.secretCodec,
          isCustomClientConfigAllowed: () => true,
        }),
        runtimeTokens: new RuntimeTokenService(options.runtimeDatabase.runtimeTokenStore),
        runtimePolicyStore: options.runtimeDatabase.runtimePolicyStore,
        transitFiles: options.transitFiles,
        actionPolicy: options.actionPolicy,
        logger: options.logger,
        connectionAuthorizationKey: async (service, name) => {
          const connection = await store.get(service, name);
          return connection?.credential.authType === "oauth2"
            ? String(connection.credential.metadata.webisAuthorizationGeneration ?? connection.id)
            : "platform";
        },
        idempotency: {
          claim: (input) =>
            options.runtimeDatabase.idempotencyStore.claim({ ...input, keyHash: `${partition}:${input.keyHash}` }),
          complete: (input) =>
            options.runtimeDatabase.idempotencyStore.complete({ ...input, keyHash: `${partition}:${input.keyHash}` }),
        },
        auth: {
          adminToken: options.adminToken,
          resolveRuntimeToken: async (candidate) =>
            candidate === token
              ? {
                  tokenId: `${identity.userId}:${identity.executionId}`,
                  allowedActions: [],
                  blockedActions: [],
                  allowedProxies: [],
                  allowedConnections: [],
                }
              : undefined,
        },
      });
      options.logger?.info(
        { userId: identity.userId, executionId: identity.executionId, path, outcome: "authorized" },
        "user connector request",
      );
      response = await server.createApp().fetch(c.req.raw);
    }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    headers.set("Cloudflare-CDN-Cache-Control", "no-store");
    headers.set("Vary", "Authorization");
    return new Response(response.body, { status: response.status, headers });
  });
  return app;
}
