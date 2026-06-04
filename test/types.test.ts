import { describe, expect, test } from "bun:test";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Scaleway from "../src/index.ts";

describe("alchemy-scaleway", () => {
  test("exports provider layer and resources", () => {
    expect(typeof Scaleway.providers).toBe("function");
    expect(typeof Scaleway.Namespace).toBe("function");
    expect(typeof Scaleway.Container).toBe("function");
    expect(typeof Scaleway.Cron).toBe("function");
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
          registryImage: "rg.fr-par.scw.cloud/example/api:latest",
          port: 3000,
        });
        const cron = yield* Scaleway.Cron("Cron", {
          container,
          schedule: "0 * * * *",
        });
        const bucket = yield* Scaleway.Bucket("Bucket", { versioning: true });
        return { container: container.url, cron: cron.cronId, bucket: bucket.bucketName };
      }),
    );
    expect(stack).toBeDefined();
  });
});
