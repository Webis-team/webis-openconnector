import type { CatalogStore } from "../../catalog-store.ts";
import type { OAuth2AuthDefinition } from "../../core/types.ts";
import type {
  OAuthClientConfig,
  OAuthClientConfigInput,
  OAuthClientConfigService,
} from "../../oauth/oauth-client-config-service.ts";
import type { UserConnectionStore } from "./user-connection-store.ts";

import { readOAuthClientConfigMetadata } from "../../oauth/oauth-client-config-service.ts";

interface PersonalOAuthConfigOptions {
  catalog: CatalogStore;
  configs: OAuthClientConfigService;
  connections: UserConnectionStore;
}

interface PersonalOAuthDetail {
  service: string;
  display_name: string;
  description: string;
  icon_url?: string;
  redirect_uri: string;
  platform_configured: boolean;
  auth: Pick<OAuth2AuthDefinition, "tokenEndpointAuthMethod" | "clientConfigFields" | "clientSetup" | "scopes">;
  client: {
    clientId: string;
    extra: Record<string, string>;
    requestedScopes?: string[];
    secret_present: boolean;
    secret_extra_present: string[];
  } | null;
}

/** Personal OAuth app settings live in the successful credential, never the global app configuration. */
export class PersonalOAuthConfig {
  private readonly options: PersonalOAuthConfigOptions;
  constructor(options: PersonalOAuthConfigOptions) {
    this.options = options;
  }

  private async saved(service: string): Promise<OAuthClientConfig | undefined> {
    const connection = await this.options.connections.get(service, "default");
    return connection?.credential.authType === "oauth2"
      ? readOAuthClientConfigMetadata(service, connection.credential.metadata)
      : undefined;
  }

  async detail(service: string): Promise<PersonalOAuthDetail> {
    const { catalog, configs } = this.options;
    const auth = configs.getOAuthDefinition(service);
    const provider = catalog.providers.find((item) => item.service === service)!;
    const saved = await this.saved(service);
    return {
      service,
      display_name: provider.displayName,
      description: provider.description ?? "",
      icon_url: provider.iconUrl,
      redirect_uri: configs.expectedRedirectUri(service),
      platform_configured: Boolean(await configs.getConfig(service)),
      auth: {
        tokenEndpointAuthMethod: auth.tokenEndpointAuthMethod,
        clientConfigFields: auth.clientConfigFields ?? [],
        clientSetup: auth.clientSetup,
        scopes: auth.scopes ?? [],
      },
      client: saved
        ? {
            clientId: saved.clientId,
            extra: Object.fromEntries(
              Object.entries(saved.extra).filter(
                ([key]) => !auth.clientConfigFields?.some((field) => field.key === key && field.secret),
              ),
            ),
            requestedScopes: saved.requestedScopes,
            secret_present: Boolean(saved.clientSecret),
            secret_extra_present: [
              ...Object.keys(saved.secretExtra).filter((key) => Boolean(saved.secretExtra[key])),
              ...(auth.clientConfigFields ?? [])
                .filter((field) => field.secret && field.location !== "secretExtra" && saved.extra[field.key])
                .map((field) => field.key),
            ],
          }
        : null,
    };
  }

  async authorizationConfig(
    service: string,
    input?: OAuthClientConfigInput,
  ): Promise<OAuthClientConfigInput | undefined> {
    const saved = await this.saved(service);
    if (!input) return saved;
    const sameClient = saved?.clientId === input.clientId.trim();
    const secretExtra = { ...input.secretExtra };
    const extra = { ...input.extra };
    const fields = this.options.configs.getOAuthDefinition(service).clientConfigFields ?? [];
    if (sameClient) {
      for (const field of fields) {
        if (field.secret && field.location !== "secretExtra" && !extra[field.key])
          extra[field.key] = saved.extra[field.key];
      }
      for (const [key, value] of Object.entries(saved.secretExtra)) {
        if (!secretExtra[key]) secretExtra[key] = value;
      }
    }
    return this.options.configs.normalizeConfig(service, {
      ...input,
      extra,
      clientSecret: input.clientSecret || (sameClient ? saved.clientSecret : ""),
      secretExtra,
    });
  }
}
