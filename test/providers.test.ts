import { afterEach, beforeEach, describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Test from "alchemy/Test/Bun";
import * as Scaleway from "../src/index.ts";
import { installScalewayMock, type ScalewayMock } from "./support/scaleway-mock.ts";
import { testProviders } from "./support/test-providers.ts";

const { test } = Test.make({ providers: testProviders() });
const adopt = Test.make({ providers: testProviders(), adopt: true });

let mock: ScalewayMock;
beforeEach(() => {
  mock = installScalewayMock();
});
afterEach(() => {
  mock.restore();
});

const requests = (method: string, fragment: string) =>
  mock.calls.filter((c) => c.method === method && c.url.includes(fragment));

describe("Namespace", () => {
  test.provider("create then update mutates in place", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Scaleway.Namespace("Ns", { description: "first", environmentVariables: { A: "1" } }),
      );
      expect(created.namespaceId).toMatch(/^ns-/);
      expect(created.region).toBe("fr-par");
      expect(created.projectId).toBe("proj-test");

      const updated = yield* stack.deploy(
        Scaleway.Namespace("Ns", { description: "second", environmentVariables: { A: "2" } }),
      );
      expect(updated.namespaceId).toBe(created.namespaceId);
      expect(updated.description).toBe("second");
      expect(requests("PATCH", "/namespaces/").length).toBeGreaterThan(0);
    }),
  );

  test.provider("changing projectId forces a replace", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(Scaleway.Namespace("Ns", { projectId: "proj-a" }));
      const second = yield* stack.deploy(Scaleway.Namespace("Ns", { projectId: "proj-b" }));
      expect(second.projectId).toBe("proj-b");
      expect(second.namespaceId).not.toBe(first.namespaceId);
      expect(requests("DELETE", "/namespaces/").length).toBeGreaterThan(0);
    }),
  );
});

describe("Container", () => {
  test.provider("creates with a namespace dependency and resolves its url", (stack) =>
    Effect.gen(function* () {
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", {});
          const api = yield* Scaleway.Container("Api", {
            namespace: ns,
            registryImage: "rg.fr-par.scw.cloud/demo/api:latest",
            port: 3000,
            privacy: "public",
          });
          return { namespaceId: ns.namespaceId, container: api };
        }),
      );
      expect(out.container.namespaceId).toBe(out.namespaceId);
      expect(out.container.url).toContain(".functions.fnc.fr-par.scw.cloud");
      expect(out.container.privacy).toBe("public");
      // create -> deploy -> poll readiness
      expect(requests("POST", "/containers/").some((c) => c.url.endsWith("/deploy"))).toBe(true);
    }),
  );

  test.provider("updating props triggers a redeploy", (stack) =>
    Effect.gen(function* () {
      const program = (description: string) =>
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", {});
          const api = yield* Scaleway.Container("Api", {
            namespace: ns,
            registryImage: "rg.fr-par.scw.cloud/demo/api:latest",
            description,
          });
          return api;
        });
      const created = yield* stack.deploy(program("v1"));
      const updated = yield* stack.deploy(program("v2"));
      expect(updated.containerId).toBe(created.containerId);
      expect(requests("PATCH", "/containers/").length).toBeGreaterThan(0);
    }),
  );
});

describe("Cron", () => {
  test.provider("create, update schedule, then delete", (stack) =>
    Effect.gen(function* () {
      const program = (schedule: string) =>
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", {});
          const api = yield* Scaleway.Container("Api", {
            namespace: ns,
            registryImage: "rg.fr-par.scw.cloud/demo/api:latest",
          });
          return yield* Scaleway.Cron("Cron", { container: api, schedule });
        });
      const created = yield* stack.deploy(program("0 * * * *"));
      expect(created.cronId).toMatch(/^cron-/);
      expect(created.schedule).toBe("0 * * * *");

      const updated = yield* stack.deploy(program("0 0 * * *"));
      expect(updated.cronId).toBe(created.cronId);
      expect(updated.schedule).toBe("0 0 * * *");
      expect(requests("PATCH", "/crons/").length).toBeGreaterThan(0);

      yield* stack.destroy();
      expect(requests("DELETE", "/crons/").length).toBeGreaterThan(0);
    }),
  );
});

describe("Domain", () => {
  test.provider("create then replace on hostname change", (stack) =>
    Effect.gen(function* () {
      const program = (hostname: string) =>
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", {});
          const api = yield* Scaleway.Container("Api", {
            namespace: ns,
            registryImage: "rg.fr-par.scw.cloud/demo/api:latest",
          });
          return yield* Scaleway.Domain("Domain", { container: api, hostname });
        });
      const created = yield* stack.deploy(program("api.example.com"));
      expect(created.domainId).toMatch(/^dom-/);
      expect(created.url).toBe("https://api.example.com");

      const replaced = yield* stack.deploy(program("www.example.com"));
      expect(replaced.hostname).toBe("www.example.com");
      expect(replaced.domainId).not.toBe(created.domainId);
      expect(requests("DELETE", "/domains/").length).toBeGreaterThan(0);
    }),
  );
});

describe("Bucket", () => {
  test.provider("create with versioning and tags", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Scaleway.Bucket("Bucket", { versioning: true, tags: { team: "infra" } }),
      );
      expect(created.bucketName).toBeTruthy();
      expect(created.region).toBe("fr-par");
      expect(created.endpoint).toContain(".s3.fr-par.scw.cloud");
      expect(created.versioning).toBe(true);
      expect(created.tags?.team).toBe("infra");
      expect(created.tags?.["alchemy:logical-id"]).toBe("Bucket");
    }),
  );

  test.provider("update toggles versioning and tags in place", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(Scaleway.Bucket("Bucket", { versioning: true }));
      const updated = yield* stack.deploy(
        Scaleway.Bucket("Bucket", { versioning: false, tags: { env: "prod" } }),
      );
      expect(updated.bucketName).toBe(created.bucketName);
      expect(updated.versioning).toBe(false);
      expect(updated.tags?.env).toBe("prod");
    }),
  );

  test.provider("changing region forces a replace", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(Scaleway.Bucket("Bucket", { region: "fr-par" }));
      const second = yield* stack.deploy(Scaleway.Bucket("Bucket", { region: "nl-ams" }));
      expect(second.region).toBe("nl-ams");
      expect(second.endpoint).toContain(".s3.nl-ams.scw.cloud");
      expect(first.region).toBe("fr-par");
    }),
  );
});

describe("adoption (read path)", () => {
  adopt.test.provider("adopts an existing owned bucket by name", (stack) =>
    Effect.gen(function* () {
      // Pre-seed a bucket Alchemy "owns" (carries the logical-id tag).
      mock.seedBucket("owned-bucket", "fr-par", { "alchemy:logical-id": "Bucket" });
      const out = yield* stack.deploy(Scaleway.Bucket("Bucket", { name: "owned-bucket" }));
      expect(out.bucketName).toBe("owned-bucket");
      expect(out.tags?.["alchemy:logical-id"]).toBe("Bucket");
      // read() found it -> no second create PUT for the bucket root.
      expect(requests("HEAD", "/owned-bucket/").length).toBeGreaterThan(0);
    }),
  );
});

describe("error handling", () => {
  test.provider("surfaces a Scaleway API error as a tagged failure", (stack) =>
    Effect.gen(function* () {
      mock.failNext("/namespaces", 422, "invalid namespace name");
      const exit = yield* Effect.exit(stack.deploy(Scaleway.Namespace("Ns", {})));
      expect(exit._tag).toBe("Failure");
      const rendered = JSON.stringify(exit);
      expect(rendered).toContain("invalid namespace name");
    }),
  );
});

describe("full stack", () => {
  test.provider("deploys namespace -> container -> cron -> domain, then destroys", (stack) =>
    Effect.gen(function* () {
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", { description: "demo" });
          const api = yield* Scaleway.Container("Api", {
            namespace: ns,
            registryImage: "rg.fr-par.scw.cloud/demo/api:latest",
            port: 3000,
          });
          const cron = yield* Scaleway.Cron("Cron", { container: api, schedule: "0 * * * *" });
          const domain = yield* Scaleway.Domain("Domain", {
            container: api,
            hostname: "api.example.com",
          });
          return {
            namespaceId: ns.namespaceId,
            containerId: api.containerId,
            cronId: cron.cronId,
            domainId: domain.domainId,
          };
        }),
      );
      expect(out.namespaceId).toMatch(/^ns-/);
      expect(out.containerId).toMatch(/^ctr-/);
      expect(out.cronId).toMatch(/^cron-/);
      expect(out.domainId).toMatch(/^dom-/);

      yield* stack.destroy();
      expect(requests("DELETE", "/namespaces/").length).toBeGreaterThan(0);
      expect(requests("DELETE", "/containers/").length).toBeGreaterThan(0);
      expect(requests("DELETE", "/crons/").length).toBeGreaterThan(0);
      expect(requests("DELETE", "/domains/").length).toBeGreaterThan(0);
    }),
  );
});
