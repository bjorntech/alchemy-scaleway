import { afterEach, beforeEach, describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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

const bucketRootRequests = (method: string, bucket: string) =>
  mock.calls.filter((c) => {
    const url = new URL(c.url);
    return c.method === method && url.pathname === `/${bucket}/` && url.search === "";
  });

const containerCreates = () =>
  mock.calls.filter((c) => {
    const url = new URL(c.url);
    return c.method === "POST" && url.pathname.endsWith("/containers");
  });

const containerPatches = () =>
  mock.calls.filter((c) => {
    const url = new URL(c.url);
    return (
      c.method === "PATCH" &&
      /\/containers\/v1\/regions\/[^/]+\/containers\/[^/]+$/.test(url.pathname)
    );
  });

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

describe("RegistryNamespace", () => {
  test.provider("creates then updates registry namespace in place", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Scaleway.RegistryNamespace("Registry", {
          description: "first",
          public: false,
        }),
      );
      expect(created.registryNamespaceId).toMatch(/^regns-/);
      expect(created.region).toBe("fr-par");
      expect(created.projectId).toBe("proj-test");
      expect(created.endpoint).toBe(`rg.fr-par.scw.cloud/${created.name}`);
      expect(created.imagePrefix).toBe(created.endpoint);

      const updated = yield* stack.deploy(
        Scaleway.RegistryNamespace("Registry", {
          description: "second",
          public: true,
        }),
      );
      expect(updated.registryNamespaceId).toBe(created.registryNamespaceId);
      expect(updated.description).toBe("second");
      expect(updated.public).toBe(true);
      expect(requests("PATCH", "/registry/v1/regions/fr-par/namespaces/")).toHaveLength(1);
    }),
  );

  test.provider("changing projectId forces a replace", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(
        Scaleway.RegistryNamespace("Registry", { projectId: "proj-a" }),
      );
      const second = yield* stack.deploy(
        Scaleway.RegistryNamespace("Registry", { projectId: "proj-b" }),
      );
      expect(second.projectId).toBe("proj-b");
      expect(second.registryNamespaceId).not.toBe(first.registryNamespaceId);
      expect(requests("DELETE", "/registry/v1/regions/fr-par/namespaces/").length).toBeGreaterThan(
        0,
      );
    }),
  );
});

describe("Secret", () => {
  test.provider("creates metadata and a redacted value version", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Scaleway.Secret("ApiSecret", {
          description: "api token",
          tags: ["app", "api"],
          value: Redacted.make("super-secret"),
        }),
      );

      expect(created.secretId).toMatch(/^secret-/);
      expect(created.projectId).toBe("proj-test");
      expect(created.region).toBe("fr-par");
      expect(created.versionCount).toBe(1);
      expect(created.latestRevision).toBe(1);
      expect(created.latestVersionStatus).toBe("enabled");
      expect(JSON.stringify(created)).not.toContain("super-secret");

      const versionCreate = requests("POST", "/secret-manager/v1beta1/regions/fr-par/secrets/")
        .filter((call) => call.url.includes("/versions"))
        .at(0);
      expect(JSON.parse(versionCreate?.body ?? "{}").data).toBe("c3VwZXItc2VjcmV0");
    }),
  );

  test.provider("updates metadata and creates a new version when value changes", (stack) =>
    Effect.gen(function* () {
      const program = (description: string, value: string, protect: boolean) =>
        Scaleway.Secret("ApiSecret", {
          description,
          value: Redacted.make(value),
          protected: protect,
        });

      const created = yield* stack.deploy(program("first", "v1", false));
      const updated = yield* stack.deploy(program("second", "v2", true));

      expect(updated.secretId).toBe(created.secretId);
      expect(updated.description).toBe("second");
      expect(updated.versionCount).toBe(2);
      expect(updated.latestRevision).toBe(2);
      expect(updated.protected).toBe(true);
      expect(
        requests("PATCH", "/secret-manager/v1beta1/regions/fr-par/secrets/").length,
      ).toBeGreaterThan(0);
      expect(requests("POST", "/protect").length).toBeGreaterThan(0);
      expect(requests("POST", "/versions")).toHaveLength(2);
    }),
  );

  test.provider("omitting an existing value keeps latest version outputs", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Scaleway.Secret("ApiSecret", { value: Redacted.make("v1") }),
      );
      const updated = yield* stack.deploy(
        Scaleway.Secret("ApiSecret", { description: "metadata" }),
      );

      expect(updated.secretId).toBe(created.secretId);
      expect(updated.versionCount).toBe(1);
      expect(updated.latestRevision).toBe(1);
      expect(updated.latestVersionStatus).toBe("enabled");
      expect(requests("POST", "/versions")).toHaveLength(1);
    }),
  );

  test.provider("changing projectId forces a replace", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(Scaleway.Secret("ApiSecret", { projectId: "proj-a" }));
      const second = yield* stack.deploy(Scaleway.Secret("ApiSecret", { projectId: "proj-b" }));

      expect(second.projectId).toBe("proj-b");
      expect(second.secretId).not.toBe(first.secretId);
      expect(
        requests("DELETE", "/secret-manager/v1beta1/regions/fr-par/secrets/").length,
      ).toBeGreaterThan(0);
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
            image: "rg.fr-par.scw.cloud/demo/api:latest",
            port: 3000,
            privacy: "public",
          });
          return { namespaceId: ns.namespaceId, container: api };
        }),
      );
      expect(out.container.namespaceId).toBe(out.namespaceId);
      expect(out.container.url).toContain(".functions.fnc.fr-par.scw.cloud");
      expect(out.container.privacy).toBe("public");
      // v1: create auto-deploys (no separate /deploy call) -> poll readiness
      expect(requests("POST", "/containers/").length).toBeGreaterThan(0);
      expect(requests("POST", "/deploy").length).toBe(0);
    }),
  );

  test.provider("sends secret environment variables as a v1 map", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", {});
          return yield* Scaleway.Container("Api", {
            namespace: ns,
            image: "rg.fr-par.scw.cloud/demo/api:latest",
            secretEnvironmentVariables: { TOKEN: Redacted.make("secret") },
          });
        }),
      );
      const create = containerCreates().at(0);
      expect(JSON.parse(create?.body ?? "{}").secret_environment_variables).toEqual({
        TOKEN: "secret",
      });
    }),
  );

  test.provider("updating props triggers a redeploy", (stack) =>
    Effect.gen(function* () {
      const program = (description: string) =>
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", {});
          const api = yield* Scaleway.Container("Api", {
            namespace: ns,
            image: "rg.fr-par.scw.cloud/demo/api:latest",
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

  test.provider("can provision domains and cron triggers from container props", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", {});
          return yield* Scaleway.Container("Api", {
            namespace: ns,
            image: "rg.fr-par.scw.cloud/demo/api:latest",
            domains: ["api.example.com"],
            crons: [
              {
                schedule: "0 * * * *",
                name: "hourly",
                destination: { httpPath: "/jobs/hourly", httpMethod: "post" },
              },
            ],
          });
        }),
      );

      expect(created.domains?.at(0)?.hostname).toBe("api.example.com");
      expect(created.domains?.at(0)?.url).toBe("https://api.example.com");
      expect(created.cronTriggers?.at(0)?.schedule).toBe("0 * * * *");
      expect(created.cronTriggers?.at(0)?.name).toBe("hourly");
      expect(requests("POST", "/domains")).toHaveLength(1);
      expect(requests("POST", "/triggers")).toHaveLength(1);
      expect(requests("POST", "/triggers").at(0)?.body).toContain("/jobs/hourly");
    }),
  );

  test.provider("updates and removes container companion resources", (stack) =>
    Effect.gen(function* () {
      const program = (schedule?: string) =>
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", {});
          return yield* Scaleway.Container("Api", {
            namespace: ns,
            image: "rg.fr-par.scw.cloud/demo/api:latest",
            domains: schedule ? ["api.example.com"] : [],
            crons: schedule ? [schedule] : [],
          });
        });

      const created = yield* stack.deploy(program("0 * * * *"));
      const updated = yield* stack.deploy(program("0 0 * * *"));
      expect(updated.containerId).toBe(created.containerId);
      expect(updated.cronTriggers?.at(0)?.triggerId).toBe(created.cronTriggers?.at(0)?.triggerId);
      expect(updated.cronTriggers?.at(0)?.schedule).toBe("0 0 * * *");

      const removed = yield* stack.deploy(program());
      expect(removed.containerId).toBe(created.containerId);
      expect(removed.domains).toBeUndefined();
      expect(removed.cronTriggers).toBeUndefined();
      expect(requests("PATCH", "/triggers/").length).toBeGreaterThan(0);
      expect(requests("DELETE", "/domains/").length).toBeGreaterThan(0);
      expect(requests("DELETE", "/triggers/").length).toBeGreaterThan(0);
      expect(containerPatches()).toHaveLength(0);
    }),
  );

  test.provider("replaces container cron when removing non-clearable fields", (stack) =>
    Effect.gen(function* () {
      const program = (withBody: boolean) =>
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", {});
          return yield* Scaleway.Container("Api", {
            namespace: ns,
            image: "rg.fr-par.scw.cloud/demo/api:latest",
            crons: [
              withBody
                ? {
                    schedule: "0 * * * *",
                    body: "payload",
                    destination: { httpPath: "/jobs/hourly" },
                  }
                : { schedule: "0 * * * *" },
            ],
          });
        });

      const created = yield* stack.deploy(program(true));
      const replaced = yield* stack.deploy(program(false));
      expect(replaced.cronTriggers?.at(0)?.triggerId).not.toBe(
        created.cronTriggers?.at(0)?.triggerId,
      );
      expect(requests("DELETE", "/triggers/").length).toBeGreaterThan(0);
    }),
  );

  test.provider("keeps moved container crons when adding and removing others", (stack) =>
    Effect.gen(function* () {
      const program = (crons: string[]) =>
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", {});
          return yield* Scaleway.Container("Api", {
            namespace: ns,
            image: "rg.fr-par.scw.cloud/demo/api:latest",
            crons,
          });
        });

      const created = yield* stack.deploy(program(["0 * * * *", "0 0 * * *"]));
      const kept = created.cronTriggers?.at(1)?.triggerId;
      const updated = yield* stack.deploy(program(["0 0 * * *", "30 0 * * *"]));

      expect(updated.cronTriggers?.at(0)?.triggerId).toBe(kept);
      expect(updated.cronTriggers?.at(1)?.triggerId).not.toBe(kept);
      expect(requests("DELETE", "/triggers/").length).toBeGreaterThan(0);
      expect(requests("POST", "/triggers")).toHaveLength(3);
    }),
  );
});

describe("Trigger", () => {
  test.provider("cron: create, update schedule, then delete", (stack) =>
    Effect.gen(function* () {
      const program = (schedule: string) =>
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", {});
          const api = yield* Scaleway.Container("Api", {
            namespace: ns,
            image: "rg.fr-par.scw.cloud/demo/api:latest",
          });
          return yield* Scaleway.Trigger("Trigger", {
            container: api,
            source: { type: "cron", schedule },
          });
        });
      const created = yield* stack.deploy(program("0 * * * *"));
      expect(created.triggerId).toMatch(/^trigger-/);
      expect(created.sourceType).toBe("cron");
      expect(created.schedule).toBe("0 * * * *");

      const updated = yield* stack.deploy(program("0 0 * * *"));
      expect(updated.triggerId).toBe(created.triggerId);
      expect(updated.schedule).toBe("0 0 * * *");
      expect(requests("PATCH", "/triggers/").length).toBeGreaterThan(0);

      yield* stack.destroy();
      expect(requests("DELETE", "/triggers/").length).toBeGreaterThan(0);
    }),
  );

  test.provider("sqs: creates a queue-sourced trigger without leaking the secret", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", {});
          const api = yield* Scaleway.Container("Api", {
            namespace: ns,
            image: "rg.fr-par.scw.cloud/demo/api:latest",
          });
          return yield* Scaleway.Trigger("Queue", {
            container: api,
            source: {
              type: "sqs",
              queueUrl: "https://sqs.fr-par.scw.cloud/123/my-queue",
              accessKeyId: "SCWACCESSKEYEXAMPLE",
              secretAccessKey: "super-secret-value",
              region: "fr-par",
            },
          });
        }),
      );
      expect(created.sourceType).toBe("sqs");
      expect(created.queueUrl).toBe("https://sqs.fr-par.scw.cloud/123/my-queue");
      // The secret is sent on create but never echoed back by the API.
      expect(requests("POST", "/triggers").at(0)?.body).toContain("super-secret-value");
      expect(JSON.stringify(created)).not.toContain("super-secret-value");
    }),
  );

  test.provider("nats: creates a subject-sourced trigger with a custom destination", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", {});
          const api = yield* Scaleway.Container("Api", {
            namespace: ns,
            image: "rg.fr-par.scw.cloud/demo/api:latest",
          });
          return yield* Scaleway.Trigger("Subject", {
            container: api,
            source: {
              type: "nats",
              serverUrls: ["nats://nats.fr-par.scw.cloud:4222"],
              subject: "events.>",
              credentialsFileContent: "BEGIN-NATS-CREDS",
            },
            destination: { httpPath: "/ingest", httpMethod: "post" },
          });
        }),
      );
      expect(created.sourceType).toBe("nats");
      expect(created.subject).toBe("events.>");
      const body = requests("POST", "/triggers").at(0)?.body;
      expect(body).toContain("/ingest");
      expect(body).toContain("BEGIN-NATS-CREDS");
      expect(JSON.stringify(created)).not.toContain("BEGIN-NATS-CREDS");
    }),
  );

  test.provider("replaces when removing destination config", (stack) =>
    Effect.gen(function* () {
      const program = (destination?: Scaleway.TriggerDestination) =>
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", {});
          const api = yield* Scaleway.Container("Api", {
            namespace: ns,
            image: "rg.fr-par.scw.cloud/demo/api:latest",
          });
          return yield* Scaleway.Trigger("Trigger", {
            container: api,
            source: { type: "cron", schedule: "0 * * * *" },
            destination,
          });
        });
      const created = yield* stack.deploy(program({ httpPath: "/ingest" }));
      const replaced = yield* stack.deploy(program());
      expect(replaced.triggerId).not.toBe(created.triggerId);
      expect(requests("DELETE", "/triggers/").length).toBeGreaterThan(0);
    }),
  );

  test.provider("replaces when removing cron body", (stack) =>
    Effect.gen(function* () {
      const program = (body?: string) =>
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", {});
          const api = yield* Scaleway.Container("Api", {
            namespace: ns,
            image: "rg.fr-par.scw.cloud/demo/api:latest",
          });
          return yield* Scaleway.Trigger("Trigger", {
            container: api,
            source: { type: "cron", schedule: "0 * * * *", body },
          });
        });
      const created = yield* stack.deploy(program("payload"));
      const replaced = yield* stack.deploy(program());
      expect(replaced.triggerId).not.toBe(created.triggerId);
    }),
  );

  test.provider("replaces when removing sqs endpoint", (stack) =>
    Effect.gen(function* () {
      const program = (endpoint?: string) =>
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", {});
          const api = yield* Scaleway.Container("Api", {
            namespace: ns,
            image: "rg.fr-par.scw.cloud/demo/api:latest",
          });
          return yield* Scaleway.Trigger("Queue", {
            container: api,
            source: {
              type: "sqs",
              queueUrl: "https://sqs.fr-par.scw.cloud/123/my-queue",
              accessKeyId: "SCWACCESSKEYEXAMPLE",
              secretAccessKey: "super-secret-value",
              endpoint,
            },
          });
        });
      const created = yield* stack.deploy(program("https://sqs.fr-par.scw.cloud"));
      const replaced = yield* stack.deploy(program());
      expect(replaced.triggerId).not.toBe(created.triggerId);
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
            image: "rg.fr-par.scw.cloud/demo/api:latest",
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
      const nlAmsPut = bucketRootRequests("PUT", second.bucketName).at(0);
      expect(nlAmsPut?.headers.get("authorization")).toContain("/nl-ams/s3/aws4_request");
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
      expect(bucketRootRequests("PUT", "owned-bucket")).toHaveLength(0);
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
  test.provider("deploys namespace -> container -> trigger -> domain, then destroys", (stack) =>
    Effect.gen(function* () {
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", { description: "demo" });
          const api = yield* Scaleway.Container("Api", {
            namespace: ns,
            image: "rg.fr-par.scw.cloud/demo/api:latest",
            port: 3000,
          });
          const trigger = yield* Scaleway.Trigger("Trigger", {
            container: api,
            source: { type: "cron", schedule: "0 * * * *" },
          });
          const domain = yield* Scaleway.Domain("Domain", {
            container: api,
            hostname: "api.example.com",
          });
          return {
            namespaceId: ns.namespaceId,
            containerId: api.containerId,
            triggerId: trigger.triggerId,
            domainId: domain.domainId,
          };
        }),
      );
      expect(out.namespaceId).toMatch(/^ns-/);
      expect(out.containerId).toMatch(/^ctr-/);
      expect(out.triggerId).toMatch(/^trigger-/);
      expect(out.domainId).toMatch(/^dom-/);

      yield* stack.destroy();
      expect(requests("DELETE", "/namespaces/").length).toBeGreaterThan(0);
      expect(requests("DELETE", "/containers/").length).toBeGreaterThan(0);
      expect(requests("DELETE", "/triggers/").length).toBeGreaterThan(0);
      expect(requests("DELETE", "/domains/").length).toBeGreaterThan(0);
    }),
  );
});
