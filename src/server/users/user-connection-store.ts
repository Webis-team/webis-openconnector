import type { IConnectionStore, StoredConnection } from "../../connection-service.ts";
import type { ResolvedCredential } from "../../core/types.ts";

import { createHash } from "node:crypto";
import { ConnectionError } from "../../connection-service.ts";

/** The reserved internal name cannot be submitted through normal connection APIs. */
export function userConnectionName(userId: string): string {
  if (!userId.trim()) throw new Error("A user identity is required.");
  return `__webis_user_${createHash("sha256").update(userId).digest("hex")}`;
}

export class UserConnectionStore implements IConnectionStore {
  readonly name: string;
  authorization?: { service: string; generation: string };
  private readonly store: IConnectionStore;
  readonly userId: string;
  constructor(store: IConnectionStore, userId: string) {
    this.store = store;
    this.userId = userId;
    this.name = userConnectionName(userId);
  }

  private personal(value: StoredConnection | undefined): value is StoredConnection {
    return (
      value?.connectionName === this.name &&
      value.credential.authType === "oauth2" &&
      value.credential.metadata.webisOwner === this.userId
    );
  }

  private visible(value: StoredConnection): StoredConnection {
    return { ...value, connectionName: value.connectionName === this.name ? "default" : value.connectionName };
  }

  async get(service: string, connectionName: string): Promise<StoredConnection | undefined> {
    if (connectionName === "default") {
      const personal = await this.store.get(service, this.name);
      if (this.personal(personal) && personal.credential.authType === "oauth2" && personal.credential.accessToken) {
        return this.visible(personal);
      }
    }
    if (connectionName.startsWith("__")) return undefined;
    const platform = await this.store.get(service, connectionName);
    return platform && ["api_key", "no_auth"].includes(platform.credential.authType) ? platform : undefined;
  }

  async list(): Promise<StoredConnection[]> {
    const values = await this.store.list();
    const personalServices = new Set(values.filter((value) => this.personal(value)).map((value) => value.service));
    return values
      .filter(
        (value) =>
          (this.personal(value) && value.credential.authType === "oauth2" && Boolean(value.credential.accessToken)) ||
          (!(value.connectionName === "default" && personalServices.has(value.service)) &&
            !value.connectionName.startsWith("__") &&
            ["api_key", "no_auth"].includes(value.credential.authType)),
      )
      .map((value) => this.visible(value));
  }

  async beginAuthorization(service: string): Promise<string> {
    if (!this.store.beginAuthorization) throw new Error("User authorization storage is unavailable.");
    const generation = await this.store.beginAuthorization(service, this.name);
    this.authorization = { service, generation };
    return generation;
  }

  async set(service: string, connectionName: string, credential: ResolvedCredential): Promise<StoredConnection> {
    const expected = this.authorization;
    if (connectionName !== "default" || credential.authType !== "oauth2" || !expected || expected.service !== service) {
      throw new ConnectionError("connection_forbidden", "Personal connections require an OAuth authorization.");
    }
    const updated = await this.store.completeAuthorization?.(service, this.name, expected.generation, {
      ...credential,
      metadata: { ...credential.metadata, webisOwner: this.userId, webisAuthorizationGeneration: expected.generation },
    });
    if (!updated)
      throw new ConnectionError("authorization_superseded", "Start authorization again; this connection changed.");
    const result = await this.get(service, "default");
    if (!result) throw new ConnectionError("connection_not_found", "Connection was disconnected.");
    return result;
  }

  async updateCredential(input: StoredConnection): Promise<boolean> {
    const current = await this.store.get(input.service, this.name);
    if (
      input.connectionName !== "default" ||
      !this.personal(current) ||
      current.id !== input.id ||
      current.revision !== input.revision ||
      input.credential.authType !== "oauth2"
    )
      return false;
    return this.store.updateCredential({
      ...input,
      connectionName: this.name,
      credential: { ...input.credential, metadata: { ...input.credential.metadata, webisOwner: this.userId } },
    });
  }

  async delete(service: string, connectionName: string): Promise<void> {
    if (connectionName !== "default")
      throw new ConnectionError("connection_forbidden", "Only your personal connection can be disconnected.");
    if (!this.store.revokeAuthorization) throw new Error("User authorization storage is unavailable.");
    await this.store.revokeAuthorization(service, this.name);
  }
}
