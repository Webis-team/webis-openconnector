import { jwtVerify } from "jose";

export interface UserIdentity {
  userId: string;
  purpose: "connections" | "execution";
  executionId?: string;
}

export interface UserIdentityConfig {
  secret: string;
  issuer: string;
  audience: string;
}

export async function verifyUserIdentity(token: string, config: UserIdentityConfig): Promise<UserIdentity | undefined> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(config.secret), {
      algorithms: ["HS256"],
      issuer: config.issuer,
      audience: config.audience,
      requiredClaims: ["exp", "iat", "sub"],
      maxTokenAge: "10m",
    });
    if (typeof payload.sub !== "string" || !payload.sub.trim()) return undefined;
    if (payload.purpose !== "connections" && payload.purpose !== "execution") return undefined;
    if (payload.purpose === "execution" && (typeof payload.execution_id !== "string" || !payload.execution_id))
      return undefined;
    return { userId: payload.sub, purpose: payload.purpose, executionId: payload.execution_id as string | undefined };
  } catch {
    return undefined;
  }
}
