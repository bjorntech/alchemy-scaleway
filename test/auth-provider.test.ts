import { describe, expect, test } from "bun:test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  resolveFromEnv,
  resolveFromStored,
  ScalewayAuthConfigSchema,
  ScalewayStoredCredentialsSchema,
} from "../src/AuthProvider.ts";

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
  test("includes the failing profile in the missing-credentials remedy", async () => {
    const error = await Effect.runPromise(
      Effect.flip(resolveFromStored(undefined, "project-a")),
    );

    expect(error.message).toContain(
      "alchemy profile edit --profile project-a --reconfigure Scaleway",
    );
  });

  test("quotes unusual profile names in the remedy", async () => {
    const error = await Effect.runPromise(
      Effect.flip(resolveFromStored(undefined, "project a")),
    );

    expect(error.message).toContain(
      "alchemy profile edit --profile 'project a' --reconfigure Scaleway",
    );
  });

  test("returns stored credentials", async () => {
    const credentials = await Effect.runPromise(
      resolveFromStored({ secretKey: "secret", region: "fr-par" }),
    );
    expect(credentials.method).toBe("stored");
    expect(credentials.region).toBe("fr-par");
  });
});

describe("beta80 auth schemas", () => {
  test("accepts only the profile auth methods", async () => {
    const valid = await withEnv(
      {},
      Schema.decodeUnknownEffect(ScalewayAuthConfigSchema)({ method: "stored" }),
    );
    expect(valid.method).toBe("stored");

    const invalid = await withEnv(
      {},
      Effect.exit(
        Schema.decodeUnknownEffect(ScalewayAuthConfigSchema)({ method: "legacy" }),
      ),
    );
    expect(Exit.isFailure(invalid)).toBe(true);
  });

  test("credential storage schema excludes missing secrets", async () => {
    const invalid = await withEnv(
      {},
      Effect.exit(
        Schema.decodeUnknownEffect(ScalewayStoredCredentialsSchema)({ region: "fr-par" }),
      ),
    );
    expect(Exit.isFailure(invalid)).toBe(true);
  });

  test("credential storage schema accepts a non-empty secret", async () => {
    const credentials = await withEnv(
      {},
      Schema.decodeUnknownEffect(ScalewayStoredCredentialsSchema)({
        secretKey: "stored-secret",
        region: "fr-par",
      }),
    );

    expect(credentials.secretKey).toBe("stored-secret");
  });

  test("credential storage schema rejects an empty secret", async () => {
    const invalid = await withEnv(
      {},
      Effect.exit(
        Schema.decodeUnknownEffect(ScalewayStoredCredentialsSchema)({
          secretKey: "",
          region: "fr-par",
        }),
      ),
    );

    expect(Exit.isFailure(invalid)).toBe(true);
  });
});
