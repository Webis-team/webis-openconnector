import type { CatalogStore, RuntimeProviderDefinition } from "../../catalog-store.ts";
import type { ConnectionService, ConnectionSummary } from "../../connection-service.ts";
import type { OAuthClientConfigService } from "../../oauth/oauth-client-config-service.ts";
import type { OAuthFlowService } from "../../oauth/oauth-flow-service.ts";
import type { Logger } from "../logger.ts";
import type { PersonalOAuthConfig } from "./personal-oauth-config.ts";
import type { UserIdentity } from "./user-identity.ts";

import { Hono } from "hono";

export interface UserRoutesOptions {
  personalConfig?: PersonalOAuthConfig;
  catalog: CatalogStore;
  connections: ConnectionService;
  configs: OAuthClientConfigService;
  oauth: OAuthFlowService;
  identity: UserIdentity;
  logger?: Logger;
}

export function createUserRoutes(options: UserRoutesOptions): Hono {
  const app = new Hono();
  const { catalog, connections, configs, oauth, identity, logger } = options;
  const summary = async (service: string): Promise<PersonalConnectionSummary> => {
    const provider = catalog.providers.find((p) => p.service === service && p.authTypes.includes("oauth2"));
    if (!provider) throw new Error("unknown_service");
    const configured = Boolean(await configs.getConfig(service));
    const connection = (await connections.listConnectionsByService(service)).find((c) => c.authType === "oauth2");
    return connectionSummary(provider, configured, connection);
  };
  app.get("/user/connections", async (c) => {
    const [values, clientConfigs] = await Promise.all([connections.listConnections(), configs.listConfigs()]);
    const byService = new Map<string, ConnectionSummary>();
    for (const connection of values) {
      if (connection.authType === "oauth2" && !byService.has(connection.service))
        byService.set(connection.service, connection);
    }
    const configured = new Map(clientConfigs.map((config) => [config.service, config.configured]));
    return c.json({
      connections: catalog.providers
        .filter((provider) => provider.authTypes.includes("oauth2"))
        .map((provider) =>
          connectionSummary(provider, configured.get(provider.service) ?? false, byService.get(provider.service)),
        ),
    });
  });
  app.get("/user/platform-tools", async (c) => {
    const values = await connections.listConnections();
    const services = new Set(
      values.filter((v) => v.authType === "api_key" || v.authType === "no_auth").map((v) => v.service),
    );
    return c.json({
      tools: [...services].map((service) => ({
        service,
        display_name: catalog.providers.find((p) => p.service === service)?.displayName ?? service,
        auth_type: values.find((v) => v.service === service)?.authType,
      })),
    });
  });
  app.get("/user/connections/:service/configuration", async (c) =>
    c.json(await options.personalConfig!.detail(c.req.param("service"))),
  );
  app.post("/user/connections/:service/authorize", async (c) => {
    const service = c.req.param("service");
    const body = await c.req.json().catch(() => ({}));
    const clientConfig = await options.personalConfig?.authorizationConfig(service, body.clientConfig);
    const result = await oauth.startAuthorization({ service, clientConfig });
    logger?.info({ userId: identity.userId, service, outcome: "started" }, "personal OAuth authorization");
    return c.json({ authorization_url: result.authorizationUrl });
  });
  app.post("/user/connections/:service/complete", async (c) => {
    const { state, code } = await c.req.json();
    if (typeof state !== "string" || typeof code !== "string" || state.length > 512 || code.length > 8192)
      return c.json({ error: "invalid_oauth_callback" }, 400);
    const result = await oauth.completeAuthorization({
      state,
      code,
      service: c.req.param("service"),
      signal: c.req.raw.signal,
    });
    logger?.info(
      { userId: identity.userId, service: result.service, outcome: "connected" },
      "personal OAuth authorization",
    );
    return c.json(result);
  });
  app.post("/user/connections/:service/check", async (c) => {
    const service = c.req.param("service");
    const item = await summary(service);
    if (item.status === "connected") {
      try {
        if (!(await connections.checkOAuthCredential(service))) item.status = "status_unknown";
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : "check_failed";
        item.status = ["oauth_token_expired", "oauth_refresh_token_required", "oauth_authorization_revoked"].includes(
          code,
        )
          ? "reauthorization_required"
          : "check_failed";
      }
    }
    return c.json({ ...item, checked_at: new Date().toISOString() });
  });
  app.delete("/user/connections/:service", async (c) => {
    await summary(c.req.param("service"));
    await connections.disconnect(c.req.param("service"));
    logger?.info(
      { userId: identity.userId, service: c.req.param("service"), outcome: "disconnected" },
      "personal OAuth authorization",
    );
    return c.json({ disconnected: true });
  });
  app.onError((error, c) => {
    const reason = "code" in error ? String(error.code) : "connection_request_failed";
    logger?.warn({ userId: identity.userId, reason, outcome: "failed" }, "personal connection request");
    return c.json({ error: reason, message: "The connection request could not be completed. Please try again." }, 400);
  });
  return app;
}

interface PersonalConnectionSummary {
  service: string;
  display_name: string;
  description?: string;
  icon_url?: string;
  homepage_url?: string;
  configured: boolean;
  status: string;
  account: {
    account_id: string;
    display_name: string;
    description?: string;
    icon_url?: string;
    homepage_url?: string;
    granted_scopes: string[];
  } | null;
}

function connectionSummary(
  provider: RuntimeProviderDefinition,
  configured: boolean,
  connection?: ConnectionSummary,
): PersonalConnectionSummary {
  return {
    service: provider.service,
    display_name: provider.displayName,
    description: provider.description ?? "",
    icon_url: provider.iconUrl,
    homepage_url: provider.homepageUrl,
    configured,
    status: connection ? "connected" : configured ? "not_connected" : "unavailable",
    account: connection?.profile
      ? {
          account_id: connection.profile.accountId,
          display_name: connection.profile.displayName,
          granted_scopes: connection.profile.grantedScopes,
        }
      : null,
  };
}
