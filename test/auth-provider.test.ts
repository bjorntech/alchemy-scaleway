import { describe, expect, test } from "bun:test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import { resolveFromEnv, resolveFromStored } from "../src/AuthProvider.ts";

const withEnv = <A, E>(env: Record<string, string>, effect: Effect.Effect<A, E, never>) =>
  Effect.runPromise(Effect.provide(effect, ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));

describe("resolveFromEnv", () => {
  test("fails when SCW_SECRET_KEY is missing", async () => {
    const exit = await withEnv({}, Effect.exit(resolveFromEnv()));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test("returns env credentials", async () => {
    const credentials = await withEnv(
      {
        SCW_SECRET_KEY: "secret",
        SCW_ACCESS_KEY: "access",
        SCW_DEFAULT_PROJECT_ID: "project",
        SCW_DEFAULT_REGION: "nl-ams",
      },
      resolveFromEnv(),
    );
    expect(credentials.method).toBe("env");
    expect(credentials.accessKey).toBe("access");
    expect(credentials.projectId).toBe("project");
    expect(credentials.region).toBe("nl-ams");
    expect(Redacted.value(credentials.secretKey)).toBe("secret");
  });
});

describe("resolveFromStored", () => {
  test("returns stored credentials", async () => {
    const credentials = await Effect.runPromise(
      resolveFromStored({ secretKey: "secret", region: "fr-par" }),
    );
    expect(credentials.method).toBe("stored");
    expect(credentials.region).toBe("fr-par");
  });
});
