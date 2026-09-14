import type { IOAuthStateStore, OAuthAuthorizationState } from "../../oauth/oauth-flow-service.ts";
import type { UserConnectionStore } from "./user-connection-store.ts";

interface UserOAuthState extends OAuthAuthorizationState {
  externalState: string;
  generation: string;
}

/** State consumption is partitioned before storage lookup, including failed callbacks. */
export class UserOAuthStateStore implements IOAuthStateStore {
  private readonly states: IOAuthStateStore;
  private readonly connections: UserConnectionStore;
  constructor(states: IOAuthStateStore, connections: UserConnectionStore) {
    this.states = states;
    this.connections = connections;
  }

  async set(state: OAuthAuthorizationState): Promise<void> {
    const generation = await this.connections.beginAuthorization(state.service);
    const stored: UserOAuthState = {
      ...state,
      state: `${this.connections.name}:${state.state}`,
      externalState: state.state,
      generation,
    };
    await this.states.set(stored);
  }

  async take(state: string): Promise<OAuthAuthorizationState | undefined> {
    const pending = (await this.states.take(`${this.connections.name}:${state}`)) as UserOAuthState | undefined;
    if (!pending || pending.externalState !== state || !pending.generation) return undefined;
    this.connections.authorization = { service: pending.service, generation: pending.generation };
    return { ...pending, state };
  }
}
