import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(fileURLToPath(new URL("../docker/Dockerfile", import.meta.url)), "utf8");
const [buildStage, runtimeStage] = dockerfile.split("\nFROM node:24-alpine\n");

describe("OpenConnector production dependency build", () => {
  it("installs each locked dependency set with bounded native fetch retries", () => {
    expect(dockerfile.match(/npm ci/g)).toHaveLength(2);
    for (const option of [
      "--fetch-retries=4",
      "--fetch-retry-factor=2",
      "--fetch-retry-mintimeout=10000",
      "--fetch-retry-maxtimeout=60000",
      "--fetch-timeout=300000",
    ]) {
      expect(dockerfile.match(new RegExp(option, "g"))).toHaveLength(2);
    }
    expect(dockerfile).not.toMatch(/(?:for|while|until).*npm ci|npm ci.*\|\|.*npm ci/s);
  });

  it("keeps source files out of both dependency layer inputs", () => {
    const buildInstall = buildStage.indexOf("RUN npm ci");
    expect(buildStage.indexOf("COPY package.json package-lock.json ./")).toBeLessThan(buildInstall);
    expect(buildStage.indexOf("COPY web/package.json ./web/package.json")).toBeLessThan(buildInstall);
    for (const source of ["COPY web ./web", "COPY src ./src", "COPY scripts ./scripts"])
      expect(buildStage.indexOf(source)).toBeGreaterThan(buildInstall);

    const runtimeInstall = runtimeStage.indexOf("RUN npm ci");
    expect(runtimeStage.indexOf("COPY package.json package-lock.json ./")).toBeLessThan(runtimeInstall);
    for (const source of ["COPY scripts/healthcheck.ts", "COPY migrations ./migrations", "COPY --from=build"])
      expect(runtimeStage.indexOf(source)).toBeGreaterThan(runtimeInstall);
  });
});
