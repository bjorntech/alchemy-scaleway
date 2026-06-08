import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { createScalewayCredentials, ScalewayCredentials } from "../src/Credentials.ts";
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
    const result = await Effect.runPromise(
      projectId("explicit").pipe(Effect.provide(credentialsLayer)),
    );
    expect(result).toBe("explicit");
  });

  test("uses explicit projectId object first", async () => {
    const result = await Effect.runPromise(
      projectId({ projectId: "explicit-object" }).pipe(Effect.provide(credentialsLayer)),
    );
    expect(result).toBe("explicit-object");
  });

  test("falls back when explicit project id is empty", async () => {
    const result = await Effect.runPromise(
      projectId("").pipe(Effect.provide(credentialsLayer)),
    );
    expect(result).toBe("from-credentials");
  });

  test("falls back to credentials project id", async () => {
    const result = await Effect.runPromise(projectId().pipe(Effect.provide(credentialsLayer)));
    expect(result).toBe("from-credentials");
  });
});

describe("createScalewayCredentials", () => {
  test("projects resolved credentials into the service shape", () => {
    const service = createScalewayCredentials({
      method: "env",
      accessKey: "access",
      secretKey: Redacted.make("secret"),
      projectId: "proj",
      region: "nl-ams",
      apiUrl: "https://api.scaleway.com",
      source: { type: "env" },
    });
    expect(service.accessKey).toBe("access");
    expect(service.region).toBe("nl-ams");
    expect(service.projectId).toBe("proj");
    expect(Redacted.value(service.secretKey)).toBe("secret");
  });
});
