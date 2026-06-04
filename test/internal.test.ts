import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ScalewayCredentials } from "../src/Credentials.ts";
import { projectId } from "../src/Internal.ts";

const credentialsLayer = Layer.succeed(
  ScalewayCredentials,
  ScalewayCredentials.of({
    secretKey: Redacted.make("secret"),
    region: "fr-par",
    apiUrl: "https://api.scaleway.com",
    projectId: "from-credentials",
  }),
);

describe("projectId", () => {
  test("uses explicit project id first", async () => {
    const result = await Effect.runPromise(projectId("explicit").pipe(Effect.provide(credentialsLayer)));
    expect(result).toBe("explicit");
  });

  test("falls back to credentials project id", async () => {
    const result = await Effect.runPromise(projectId().pipe(Effect.provide(credentialsLayer)));
    expect(result).toBe("from-credentials");
  });
});
