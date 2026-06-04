import { describe, expect, test } from "bun:test";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Scaleway from "../src/index.ts";

describe("alchemy-scaleway", () => {
  test("exports provider layer and resources", () => {
    expect(typeof Scaleway.providers).toBe("function");
    expect(typeof Scaleway.Namespace).toBe("function");
    expect(typeof Scaleway.Container).toBe("function");
    expect(typeof Scaleway.Trigger).toBe("function");
    expect(typeof Scaleway.Domain).toBe("function");
    expect(typeof Scaleway.Bucket).toBe("function");
  });

  test("resources compose in a stack program", () => {
    const stack = Alchemy.Stack(
      "typecheck",
      { providers: Scaleway.providers() as any, state: Alchemy.inMemoryState() },
      Effect.gen(function* () {
        const namespace = yield* Scaleway.Namespace("Namespace", {});
        const container = yield* Scaleway.Container("Api", {
          namespace,
          image: "rg.fr-par.scw.cloud/example/api:latest",
          port: 3000,
        });
        const trigger = yield* Scaleway.Trigger("Trigger", {
          container,
          source: { type: "cron", schedule: "0 * * * *" },
        });
        const bucket = yield* Scaleway.Bucket("Bucket", { versioning: true });
        return { container: container.url, trigger: trigger.triggerId, bucket: bucket.bucketName };
      }),
    );
    expect(stack).toBeDefined();
  });
});
