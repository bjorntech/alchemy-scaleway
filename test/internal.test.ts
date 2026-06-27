import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { createScalewayCredentials, ScalewayCredentials } from "../src/Credentials.ts";
import { parentReadiness, projectId } from "../src/Internal.ts";

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

describe("parentReadiness", () => {
  test("returns the parent's status output for a resource reference", () => {
    const statusOutput = { kind: "Output" };
    const resourceRef = { Type: "Scaleway.Function", status: statusOutput };
    // A non-stable attribute reference keeps a real Alchemy upstream edge so a
    // child custom domain waits for the parent's reconcile instead of running
    // concurrently against the parent's stable identity alone.
    expect(parentReadiness(resourceRef)).toBe(statusOutput);
  });

  test("returns undefined for a raw id string reference", () => {
    expect(parentReadiness("fn-1234")).toBeUndefined();
  });

  test("returns undefined for null", () => {
    expect(parentReadiness(null)).toBeUndefined();
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
