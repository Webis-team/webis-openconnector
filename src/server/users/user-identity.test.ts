import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { verifyUserIdentity } from "./user-identity.ts";

const config = { secret: "a-test-only-signing-secret", issuer: "gateway", audience: "connector" };
async function token(claims: Record<string, unknown> = {}, secret = config.secret): Promise<string> {
  return new SignJWT({ purpose: "execution", execution_id: "execution-a", ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(config.issuer)
    .setAudience(config.audience)
    .setSubject("user-a")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(secret));
}

describe("user connector identity", () => {
  it("accepts a signed execution identity", async () => {
    expect(await verifyUserIdentity(await token(), config)).toEqual({
      userId: "user-a",
      purpose: "execution",
      executionId: "execution-a",
    });
  });
  it("rejects an untrusted signer, wrong audience, wrong issuer and wrong purpose", async () => {
    expect(await verifyUserIdentity(await token({}, "other-secret"), config)).toBeUndefined();
    expect(await verifyUserIdentity(await token(), { ...config, audience: "other" })).toBeUndefined();
    expect(await verifyUserIdentity(await token(), { ...config, issuer: "other" })).toBeUndefined();
    expect(await verifyUserIdentity(await token({ purpose: "admin" }), config)).toBeUndefined();
    expect(await verifyUserIdentity(await token({ execution_id: undefined }), config)).toBeUndefined();
  });
  it("rejects expired identities", async () => {
    const expired = await new SignJWT({ purpose: "connections" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(config.issuer)
      .setAudience(config.audience)
      .setSubject("user-a")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1)
      .sign(new TextEncoder().encode(config.secret));
    expect(await verifyUserIdentity(expired, config)).toBeUndefined();
  });
});
