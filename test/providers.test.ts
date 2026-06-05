import { afterEach, beforeEach, describe, expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { createHash } from "node:crypto";
import * as Test from "alchemy/Test/Bun";
import * as Scaleway from "../src/index.ts";
import { installScalewayMock, type ScalewayMock } from "./support/scaleway-mock.ts";
import { testProviders } from "./support/test-providers.ts";

const { test } = Test.make({ providers: testProviders() });
const adopt = Test.make({ providers: testProviders(), adopt: true });
const vpcLifecycleLayer = Layer.mergeAll(
  Scaleway.VpcProvider(),
  Scaleway.PrivateNetworkProvider(),
  Scaleway.VpcRouteProvider(),
  Scaleway.VpcConnectorProvider(),
  Scaleway.InstanceProvider(),
  Scaleway.SecurityGroupProvider(),
  Scaleway.FlexibleIpProvider(),
  Scaleway.PrivateNicProvider(),
).pipe(
  Layer.provideMerge(
    Layer.succeed(
      Scaleway.ScalewayCredentials,
      Scaleway.ScalewayCredentials.of({
        secretKey: Redacted.make("test-secret"),
        accessKey: "test-access",
        region: "fr-par",
        apiUrl: "https://api.scaleway.com",
        projectId: "proj-test",
      }),
    ),
  ),
  Layer.orDie,
);

let mock: ScalewayMock;
beforeEach(() => {
  mock = installScalewayMock();
});
afterEach(() => {
  mock.restore();
});

const requests = (method: string, fragment: string) =>
  mock.calls.filter((c) => c.method === method && c.url.includes(fragment));

const sha256 = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const terminateActions = () =>
  requests("POST", "/action").filter((call) => JSON.parse(call.body).action === "terminate");

const instanceDeleteRequests = () => terminateActions().length + requests("DELETE", "/servers/").length;

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

  test.provider("generates container names within Scaleway limits", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", {});
          return yield* Scaleway.Container(
            "VeryLongLogicalContainerNameThatWouldOtherwiseExceedScalewayLimits",
            {
              namespace: ns,
              image: "rg.fr-par.scw.cloud/demo/api:latest",
            },
          );
        }),
      );
      const create = containerCreates().at(0);
      const body = JSON.parse(create?.body ?? "{}");
      expect(body.name.length).toBeLessThanOrEqual(34);
    }),
  );

  test.provider("rejects explicit container names that exceed Scaleway limits", (stack) =>
    Effect.gen(function* () {
      const deploy = stack.deploy(
        Effect.gen(function* () {
          const ns = yield* Scaleway.Namespace("Ns", {});
          return yield* Scaleway.Container("Api", {
            namespace: ns,
            name: "this-container-name-is-definitely-too-long-for-scaleway",
            image: "rg.fr-par.scw.cloud/demo/api:latest",
          });
        }),
      );
      yield* Effect.flip(deploy).pipe(
        Effect.map((error) => {
          expect(String(error)).toContain("Scaleway container name must be 34 characters or fewer");
        }),
      );
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

describe("Vpc", () => {
  test.provider("creates then updates VPC metadata in place", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Scaleway.Vpc("Network", {
          tags: ["team=platform"],
          routing: true,
          customRoutesPropagation: true,
        }),
      );
      expect(created.vpcId).toMatch(/^vpc-/);
      expect(created.region).toBe("fr-par");
      expect(created.projectId).toBe("proj-test");
      expect(created.routing).toBe(true);
      expect(created.customRoutesPropagation).toBe(true);
      expect(created.tags).toContain("alchemy:logical-id=Network");

      const updated = yield* stack.deploy(
        Scaleway.Vpc("Network", {
          tags: ["team=network"],
          routing: true,
          customRoutesPropagation: true,
        }),
      );
      expect(updated.vpcId).toBe(created.vpcId);
      expect(updated.tags).toContain("team=network");
      expect(requests("PATCH", "/vpc/v2/regions/fr-par/vpcs/")).toHaveLength(1);
      expect(requests("POST", "/enable-routing")).toHaveLength(1);
      expect(requests("POST", "/enable-custom-routes-propagation")).toHaveLength(1);
    }),
  );

  test.provider("changing projectId forces a replace", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(Scaleway.Vpc("Network", { projectId: "proj-a" }));
      const second = yield* stack.deploy(Scaleway.Vpc("Network", { projectId: "proj-b" }));
      expect(second.projectId).toBe("proj-b");
      expect(second.vpcId).not.toBe(first.vpcId);
      expect(requests("DELETE", "/vpc/v2/regions/fr-par/vpcs/").length).toBeGreaterThan(0);
    }),
  );

  test.provider("omitted routing does not cause repeated updates", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(Scaleway.Vpc("Network", {}));
      const redeployed = yield* stack.deploy(Scaleway.Vpc("Network", {}));
      expect(redeployed.vpcId).toBe(created.vpcId);
      expect(requests("PATCH", "/vpc/v2/regions/fr-par/vpcs/")).toHaveLength(0);
      expect(requests("POST", "/enable-routing")).toHaveLength(0);
      expect(requests("POST", "/enable-custom-routes-propagation")).toHaveLength(0);
    }),
  );

  test.provider("rejects disabling one-way VPC flags", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(
        Scaleway.Vpc("Network", { routing: true, customRoutesPropagation: true }),
      );

      const routingExit = yield* Effect.exit(
        stack.deploy(Scaleway.Vpc("Network", { routing: false, customRoutesPropagation: true })),
      );
      expect(routingExit._tag).toBe("Failure");

      const propagationExit = yield* Effect.exit(
        stack.deploy(Scaleway.Vpc("Network", { routing: true, customRoutesPropagation: false })),
      );
      expect(propagationExit._tag).toBe("Failure");
    }),
  );

  test.provider("read returns existing VPCs and ignores missing ones", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(Scaleway.Vpc("Network", { tags: ["read=ok"] }));
      const provider = yield* Scaleway.Vpc.Provider.pipe(Effect.provide(vpcLifecycleLayer));
      const read = yield* provider.read!({
        id: "Network",
        instanceId: "test",
        olds: { tags: ["read=ok"] },
        output: created,
      });
      expect(read?.vpcId).toBe(created.vpcId);

      mock.removeVpc(created.vpcId);
      const missing = yield* provider.read!({
        id: "Network",
        instanceId: "test",
        olds: { tags: ["read=ok"] },
        output: created,
      });
      expect(missing).toBeUndefined();
    }),
  );

});

describe("PrivateNetwork", () => {
  test.provider("creates against a VPC and syncs mutable fields", (stack) =>
    Effect.gen(function* () {
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Scaleway.Vpc("Network", {});
          const pn = yield* Scaleway.PrivateNetwork("Lan", {
            vpc,
            tags: ["scope=app"],
            subnets: ["10.10.0.0/24"],
            dhcp: true,
            defaultRoutePropagation: true,
          });
          return { vpcId: vpc.vpcId, pn };
        }),
      );
      expect(out.pn.privateNetworkId).toMatch(/^pn-/);
      expect(out.pn.vpcId).toBe(out.vpcId);
      expect(out.pn.subnets).toEqual(["10.10.0.0/24"]);
      expect(out.pn.dhcp).toBe(true);

      const updated = yield* stack.deploy(
        Scaleway.PrivateNetwork("Lan", {
          vpc: out.vpcId,
          tags: ["scope=data"],
          subnets: ["10.20.0.0/24"],
          dhcp: true,
          defaultRoutePropagation: false,
        }),
      );
      expect(updated.privateNetworkId).toBe(out.pn.privateNetworkId);
      expect(updated.subnets).toEqual(["10.20.0.0/24"]);
      expect(updated.tags).toContain("scope=data");
      expect(requests("PATCH", "/private-networks/")).toHaveLength(1);
      expect(requests("POST", "/subnets")).toHaveLength(1);
      expect(requests("DELETE", "/subnets")).toHaveLength(1);
      expect(requests("POST", "/enable-dhcp")).toHaveLength(1);
    }),
  );

  test.provider("changing VPC forces a replace", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(Scaleway.PrivateNetwork("Lan", { vpc: "vpc-a" }));
      const second = yield* stack.deploy(Scaleway.PrivateNetwork("Lan", { vpc: "vpc-b" }));
      expect(second.vpcId).toBe("vpc-b");
      expect(second.privateNetworkId).not.toBe(first.privateNetworkId);
      expect(requests("DELETE", "/private-networks/").length).toBeGreaterThan(0);
    }),
  );

  test.provider("omitted optional fields do not cause repeated updates", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(Scaleway.PrivateNetwork("Lan", {}));
      const redeployed = yield* stack.deploy(Scaleway.PrivateNetwork("Lan", {}));
      expect(redeployed.privateNetworkId).toBe(created.privateNetworkId);
      expect(requests("PATCH", "/private-networks/")).toHaveLength(0);
      expect(requests("POST", "/subnets")).toHaveLength(0);
      expect(requests("DELETE", "/subnets")).toHaveLength(0);
      expect(requests("POST", "/enable-dhcp")).toHaveLength(0);
    }),
  );

  test.provider("rejects disabling DHCP once enabled", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(Scaleway.PrivateNetwork("Lan", { dhcp: true }));
      const exit = yield* Effect.exit(stack.deploy(Scaleway.PrivateNetwork("Lan", { dhcp: false })));
      expect(exit._tag).toBe("Failure");
    }),
  );

  test.provider("read returns existing Private Networks and ignores missing ones", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(Scaleway.PrivateNetwork("Lan", { tags: ["read=ok"] }));
      const provider = yield* Scaleway.PrivateNetwork.Provider.pipe(Effect.provide(vpcLifecycleLayer));
      const read = yield* provider.read!({
        id: "Lan",
        instanceId: "test",
        olds: { tags: ["read=ok"] },
        output: created,
      });
      expect(read?.privateNetworkId).toBe(created.privateNetworkId);

      mock.removePrivateNetwork(created.privateNetworkId);
      const missing = yield* provider.read!({
        id: "Lan",
        instanceId: "test",
        olds: { tags: ["read=ok"] },
        output: created,
      });
      expect(missing).toBeUndefined();
    }),
  );
});

describe("VpcAcl", () => {
  test.provider("sets and updates the owned IPv4 ACL rule set", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Scaleway.VpcAcl("Acl", {
          vpc: "vpc-acl",
          defaultPolicy: "drop",
          rules: [{ protocol: "TCP", action: "accept", destinationPort: 443 }],
        }),
      );
      expect(created.vpcId).toBe("vpc-acl");
      expect(created.ipVersion).toBe("ipv4");
      expect(created.defaultPolicy).toBe("drop");
      expect(created.rules).toHaveLength(1);

      const updated = yield* stack.deploy(
        Scaleway.VpcAcl("Acl", {
          vpc: "vpc-acl",
          defaultPolicy: "accept",
          rules: [{ protocol: "UDP", action: "drop", source: "10.0.0.0/8" }],
        }),
      );
      expect(updated.defaultPolicy).toBe("accept");
      expect(updated.rules[0]?.protocol).toBe("UDP");
      expect(requests("PUT", "/acl-rules?is_ipv6=false")).toHaveLength(2);

      yield* stack.destroy();
      const reset = requests("PUT", "/acl-rules?is_ipv6=false").at(-1);
      expect(JSON.parse(reset?.body ?? "{}")).toEqual({ default_policy: "accept", rules: [] });
    }),
  );

  test.provider("changing IP version forces a replace", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(
        Scaleway.VpcAcl("Acl", { vpc: "vpc-acl", ipVersion: "ipv4", defaultPolicy: "drop" }),
      );
      const second = yield* stack.deploy(
        Scaleway.VpcAcl("Acl", { vpc: "vpc-acl", ipVersion: "ipv6", defaultPolicy: "drop" }),
      );
      expect(first.ipVersion).toBe("ipv4");
      expect(second.ipVersion).toBe("ipv6");
      expect(requests("PUT", "/acl-rules?is_ipv6=true")).toHaveLength(1);
    }),
  );

  test.provider("identical ACL rule sets redeploy as a noop", (stack) =>
    Effect.gen(function* () {
      const props = {
        vpc: "vpc-acl",
        defaultPolicy: "drop" as const,
        rules: [{ protocol: "TCP" as const, action: "accept" as const, destinationPort: 443 }],
      };
      const created = yield* stack.deploy(Scaleway.VpcAcl("Acl", props));
      const redeployed = yield* stack.deploy(Scaleway.VpcAcl("Acl", props));
      expect(redeployed.vpcId).toBe(created.vpcId);
      expect(requests("PUT", "/acl-rules?is_ipv6=false")).toHaveLength(1);
    }),
  );
});

describe("VpcRoute", () => {
  test.provider("creates then updates a custom route in place", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Scaleway.VpcRoute("Route", {
          vpc: "vpc-route",
          destination: "10.90.0.0/24",
          nextHop: { type: "privateNetwork", privateNetwork: "pn-a" },
          description: "first",
          tags: ["scope=app"],
        }),
      );
      expect(created.routeId).toMatch(/^route-/);
      expect(created.vpcId).toBe("vpc-route");
      expect(created.nextHopPrivateNetworkId).toBe("pn-a");
      expect(created.tags).toContain("alchemy:logical-id=Route");

      const updated = yield* stack.deploy(
        Scaleway.VpcRoute("Route", {
          vpc: "vpc-route",
          destination: "10.91.0.0/24",
          nextHop: { type: "resource", resourceId: "resource-a" },
          description: "second",
          tags: ["scope=data"],
        }),
      );
      expect(updated.routeId).toBe(created.routeId);
      expect(updated.destination).toBe("10.91.0.0/24");
      expect(updated.nextHopResourceId).toBe("resource-a");
      expect(updated.nextHopPrivateNetworkId).toBeUndefined();

      const redeployed = yield* stack.deploy(
        Scaleway.VpcRoute("Route", {
          vpc: "vpc-route",
          destination: "10.91.0.0/24",
          nextHop: { type: "resource", resourceId: "resource-a" },
          description: "second",
          tags: ["scope=data"],
        }),
      );
      expect(redeployed.routeId).toBe(created.routeId);
      expect(requests("PATCH", "/vpc/v2/regions/fr-par/routes/")).toHaveLength(1);
    }),
  );

  test.provider("changing VPC forces a replace", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(
        Scaleway.VpcRoute("Route", {
          vpc: "vpc-a",
          destination: "10.90.0.0/24",
          nextHop: { type: "resource", resourceId: "resource-a" },
        }),
      );
      const second = yield* stack.deploy(
        Scaleway.VpcRoute("Route", {
          vpc: "vpc-b",
          destination: "10.90.0.0/24",
          nextHop: { type: "resource", resourceId: "resource-a" },
        }),
      );
      expect(second.vpcId).toBe("vpc-b");
      expect(second.routeId).not.toBe(first.routeId);
      expect(requests("DELETE", "/vpc/v2/regions/fr-par/routes/").length).toBeGreaterThan(0);
    }),
  );

  test.provider("uses VPC connector next hops", (stack) =>
    Effect.gen(function* () {
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const connector = yield* Scaleway.VpcConnector("Connector", {
            vpc: "vpc-a",
            targetVpc: "vpc-b",
          });
          const route = yield* Scaleway.VpcRoute("Route", {
            vpc: "vpc-a",
            destination: "10.92.0.0/24",
            nextHop: { type: "vpcConnector", vpcConnector: connector },
          });
          return { connector, route };
        }),
      );
      expect(out.route.nextHopVpcConnectorId).toBe(out.connector.vpcConnectorId);
    }),
  );

  test.provider("read returns existing VPC routes and ignores missing ones", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Scaleway.VpcRoute("Route", {
          vpc: "vpc-a",
          destination: "10.90.0.0/24",
          nextHop: { type: "resource", resourceId: "resource-a" },
        }),
      );
      const provider = yield* Scaleway.VpcRoute.Provider.pipe(Effect.provide(vpcLifecycleLayer));
      const read = yield* provider.read!({
        id: "Route",
        instanceId: "test",
        olds: {
          vpc: "vpc-a",
          destination: "10.90.0.0/24",
          nextHop: { type: "resource", resourceId: "resource-a" },
        },
        output: created,
      });
      expect(read?.routeId).toBe(created.routeId);

      mock.removeRoute(created.routeId);
      const missing = yield* provider.read!({
        id: "Route",
        instanceId: "test",
        olds: {
          vpc: "vpc-a",
          destination: "10.90.0.0/24",
          nextHop: { type: "resource", resourceId: "resource-a" },
        },
        output: created,
      });
      expect(missing).toBeUndefined();
    }),
  );
});

describe("VpcConnector", () => {
  test.provider("accepts VPC resource references", (stack) =>
    Effect.gen(function* () {
      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* Scaleway.Vpc("Source", {});
          const target = yield* Scaleway.Vpc("Target", {});
          const connector = yield* Scaleway.VpcConnector("Connector", {
            vpc: source,
            targetVpc: target,
          });
          return { source, target, connector };
        }),
      );
      expect(out.connector.vpcId).toBe(out.source.vpcId);
      expect(out.connector.targetVpcId).toBe(out.target.vpcId);
    }),
  );

  test.provider("creates then updates connector metadata in place", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Scaleway.VpcConnector("Connector", {
          vpc: "vpc-a",
          targetVpc: "vpc-b",
          tags: ["scope=app"],
        }),
      );
      expect(created.vpcConnectorId).toMatch(/^vpc-connector-/);
      expect(created.vpcId).toBe("vpc-a");
      expect(created.targetVpcId).toBe("vpc-b");
      expect(created.status).toBe("orphan");
      expect(created.tags).toContain("alchemy:logical-id=Connector");

      const updated = yield* stack.deploy(
        Scaleway.VpcConnector("Connector", {
          name: "renamed-connector",
          vpc: "vpc-a",
          targetVpc: "vpc-b",
          tags: ["scope=data"],
        }),
      );
      expect(updated.vpcConnectorId).toBe(created.vpcConnectorId);
      expect(updated.name).toBe("renamed-connector");
      expect(updated.tags).toContain("scope=data");
      expect(requests("PATCH", "/vpc-connectors/")).toHaveLength(1);
    }),
  );

  test.provider("changing target VPC forces a replace", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(
        Scaleway.VpcConnector("Connector", { vpc: "vpc-a", targetVpc: "vpc-b" }),
      );
      const second = yield* stack.deploy(
        Scaleway.VpcConnector("Connector", { vpc: "vpc-a", targetVpc: "vpc-c" }),
      );
      expect(second.targetVpcId).toBe("vpc-c");
      expect(second.vpcConnectorId).not.toBe(first.vpcConnectorId);
      expect(requests("DELETE", "/vpc-connectors/").length).toBeGreaterThan(0);
    }),
  );

  test.provider("read returns existing VPC connectors and ignores missing ones", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Scaleway.VpcConnector("Connector", { vpc: "vpc-a", targetVpc: "vpc-b" }),
      );
      const provider = yield* Scaleway.VpcConnector.Provider.pipe(Effect.provide(vpcLifecycleLayer));
      const read = yield* provider.read!({
        id: "Connector",
        instanceId: "test",
        olds: { vpc: "vpc-a", targetVpc: "vpc-b" },
        output: created,
      });
      expect(read?.vpcConnectorId).toBe(created.vpcConnectorId);

      mock.removeVpcConnector(created.vpcConnectorId);
      const missing = yield* provider.read!({
        id: "Connector",
        instanceId: "test",
        olds: { vpc: "vpc-a", targetVpc: "vpc-b" },
        output: created,
      });
      expect(missing).toBeUndefined();
    }),
  );
});

describe("Instance", () => {
  test.provider("sets cloud-init user data before first boot without storing script", (stack) =>
    Effect.gen(function* () {
      const script = `#!/bin/bash
set -e

apt-get update
apt-get install -y docker.io
systemctl enable docker
systemctl start docker
`;

      const created = yield* stack.deploy(
        Scaleway.Instance("App", {
          commercialType: "DEV1-S",
          image: "ubuntu_jammy",
          cloudInit: Redacted.make(script),
          desiredState: "running",
        }),
      );

      expect(created.state).toBe("running");
      expect(created.cloudInitHash).toBe(sha256(script));
      expect(JSON.stringify(created)).not.toContain("apt-get install");

      const creates = requests("POST", "/servers");
      const createBody = JSON.parse(creates[0].body);
      expect(createBody.stopped).toBeUndefined();
      expect(createBody.cloud_init).toBeUndefined();

      const userData = requests("PATCH", "/user_data/cloud-init");
      expect(userData).toHaveLength(1);
      expect(userData[0].headers.get("content-type")).toBe("text/plain");
      expect(userData[0].body).toBe(script);

      const actions = requests("POST", "/action");
      expect(JSON.parse(actions.at(-1)!.body).action).toBe("poweron");
    }),
  );

  test.provider("changing cloud-init forces an instance replacement", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(
        Scaleway.Instance("App", { commercialType: "DEV1-S", cloudInit: "#!/bin/bash\necho first\n" }),
      );
      const second = yield* stack.deploy(
        Scaleway.Instance("App", { commercialType: "DEV1-S", cloudInit: "#!/bin/bash\necho second\n" }),
      );

      expect(second.serverId).not.toBe(first.serverId);
      expect(second.cloudInitHash).toBe(sha256("#!/bin/bash\necho second\n"));
      expect(instanceDeleteRequests()).toBeGreaterThan(0);
      expect(requests("PATCH", "/user_data/cloud-init").map((call) => call.body)).toEqual(["#!/bin/bash\necho first\n", "#!/bin/bash\necho second\n"]);
    }),
  );

  test.provider("creates then updates instance metadata and attachments", (stack) =>
    Effect.gen(function* () {
      mock.addFlexibleIp("ip-existing");
      const created = yield* stack.deploy(
        Scaleway.Instance("App", {
          zone: "fr-par-1",
          commercialType: "DEV1-S",
          image: "ubuntu_noble",
          publicIps: ["ip-existing"],
          securityGroup: "sg-existing",
          tags: ["role=app"],
          volumes: { "0": { name: "root", size: 20_000_000_000, volumeType: "sbs_volume", boot: true } },
        }),
      );
      expect(created.serverId).toMatch(/^srv-/);
      expect(created.zone).toBe("fr-par-1");
      expect(created.projectId).toBe("proj-test");
      expect(created.commercialType).toBe("DEV1-S");
      expect(created.imageName).toBe("ubuntu_noble");
      expect(created.publicIpIds).toContain("ip-existing");
      expect(created.securityGroupId).toBe("sg-existing");
      expect(created.tags).toContain("alchemy:logical-id=App");

      const updated = yield* stack.deploy(
        Scaleway.Instance("App", {
          zone: "fr-par-1",
          commercialType: "DEV1-S",
          image: "ubuntu_noble",
          publicIps: [],
          tags: ["role=worker"],
          protected: true,
          volumes: { "0": { name: "root", size: 20_000_000_000, volumeType: "sbs_volume", boot: true } },
        }),
      );
      expect(updated.serverId).toBe(created.serverId);
      expect(updated.publicIpIds).toEqual([]);
      expect(updated.securityGroupId).toBe("sg-existing");
      expect(updated.protected).toBe(true);
      expect(requests("PATCH", "/servers/")).toHaveLength(1);
      expect(requests("PATCH", "/ips/")).toHaveLength(1);

      yield* stack.deploy(
        Scaleway.Instance("App", {
          zone: "fr-par-1",
          commercialType: "DEV1-S",
          image: "ubuntu_noble",
          publicIps: [],
          tags: ["role=worker"],
          protected: true,
          volumes: { "0": { name: "root", size: 20_000_000_000, volumeType: "sbs_volume", boot: true } },
        }),
      );
      expect(requests("PATCH", "/servers/")).toHaveLength(1);
    }),
  );

  test.provider("changing instance image forces a replace", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(Scaleway.Instance("App", { commercialType: "DEV1-S", image: "ubuntu_noble" }));
      const second = yield* stack.deploy(Scaleway.Instance("App", { commercialType: "DEV1-S", image: "debian_bookworm" }));
      expect(second.serverId).not.toBe(first.serverId);
      expect(second.imageName).toBe("debian_bookworm");
      expect(instanceDeleteRequests()).toBeGreaterThan(0);
    }),
  );

  test.provider("destroy deletes Alchemy-created Block Storage volumes", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(Scaleway.Instance("App", { commercialType: "DEV1-S" }));
      expect(created.createdVolumeIds?.length).toBeGreaterThan(0);

      yield* stack.destroy();

      expect(instanceDeleteRequests()).toBe(1);
      expect(requests("DELETE", "/volumes/").map((call) => call.url)).toEqual(
        expect.arrayContaining(created.createdVolumeIds!.map((id) => expect.stringContaining(`/volumes/${id}`))),
      );
    }),
  );

  test.provider("destroy preserves explicitly attached Block Storage volumes", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Scaleway.Instance("App", {
          commercialType: "DEV1-S",
          volumes: { "0": { id: "vol-existing", volumeType: "sbs_volume", boot: true } },
        }),
      );
      expect(created.createdVolumeIds).toEqual([]);

      yield* stack.destroy();

      expect(instanceDeleteRequests()).toBe(1);
      expect(requests("DELETE", "/volumes/vol-existing")).toHaveLength(0);
    }),
  );

  test.provider("changing instance volume snapshot forces a replace", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(
        Scaleway.Instance("App", {
          commercialType: "DEV1-S",
          volumes: { "0": { name: "root", size: 20_000_000_000, volumeType: "sbs_volume", boot: true, baseSnapshot: "snap-a" } },
        }),
      );
      const second = yield* stack.deploy(
        Scaleway.Instance("App", {
          commercialType: "DEV1-S",
          volumes: { "0": { name: "root", size: 20_000_000_000, volumeType: "sbs_volume", boot: true, baseSnapshot: "snap-b" } },
        }),
      );
      expect(second.serverId).not.toBe(first.serverId);
      expect(instanceDeleteRequests()).toBeGreaterThan(0);
      const third = yield* stack.deploy(
        Scaleway.Instance("App", {
          commercialType: "DEV1-S",
          volumes: { "0": { name: "root", size: 20_000_000_000, volumeType: "sbs_volume", boot: true } },
        }),
      );
      expect(third.serverId).not.toBe(second.serverId);
      expect(instanceDeleteRequests()).toBeGreaterThan(1);
    }),
  );

  test.provider("removing an instance volume forces a replace", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(
        Scaleway.Instance("App", {
          commercialType: "DEV1-S",
          volumes: {
            "0": { name: "root", size: 20_000_000_000, volumeType: "sbs_volume", boot: true },
            "1": { name: "data", size: 10_000_000_000, volumeType: "sbs_volume" },
          },
        }),
      );
      const second = yield* stack.deploy(
        Scaleway.Instance("App", {
          commercialType: "DEV1-S",
          volumes: { "0": { name: "root", size: 20_000_000_000, volumeType: "sbs_volume", boot: true } },
        }),
      );
      expect(second.serverId).not.toBe(first.serverId);
      expect(instanceDeleteRequests()).toBeGreaterThan(0);
    }),
  );

  test.provider("desired state performs instance power actions", (stack) =>
    Effect.gen(function* () {
      const stopped = yield* stack.deploy(Scaleway.Instance("App", { commercialType: "DEV1-S", desiredState: "stopped" }));
      expect(stopped.state).toBe("stopped");
      const running = yield* stack.deploy(Scaleway.Instance("App", { commercialType: "DEV1-S", desiredState: "running" }));
      expect(running.serverId).toBe(stopped.serverId);
      expect(running.state).toBe("running");
      expect(requests("POST", "/action")).toHaveLength(1);
    }),
  );

  test.provider("read returns existing instances and ignores missing ones", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(Scaleway.Instance("App", { zone: "fr-par-1", commercialType: "DEV1-S" }));
      const provider = yield* Scaleway.Instance.Provider.pipe(Effect.provide(vpcLifecycleLayer));
      const read = yield* provider.read!({
        id: "App",
        instanceId: "test",
        olds: { zone: "fr-par-1", commercialType: "DEV1-S" },
        output: created,
      });
      expect(read?.serverId).toBe(created.serverId);

      mock.removeServer(created.serverId);
      const missing = yield* provider.read!({
        id: "App",
        instanceId: "test",
        olds: { zone: "fr-par-1", commercialType: "DEV1-S" },
        output: created,
      });
      expect(missing).toBeUndefined();
    }),
  );
});

describe("SecurityGroup", () => {
  test.provider("creates then updates security group rules in place", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Scaleway.SecurityGroup("Firewall", {
          zone: "fr-par-1",
          description: "public ingress",
          rules: [
            { protocol: "TCP", port: 22 },
            { protocol: "UDP", portRange: { from: 16384, to: 65535 } },
          ],
        }),
      );
      expect(created.securityGroupId).toMatch(/^sg-/);
      expect(created.zone).toBe("fr-par-1");
      expect(created.inboundDefaultPolicy).toBe("drop");
      expect(created.outboundDefaultPolicy).toBe("accept");
      expect(created.rules).toHaveLength(2);
      expect(created.tags).toContain("alchemy:logical-id=Firewall");

      const updated = yield* stack.deploy(
        Scaleway.SecurityGroup("Firewall", {
          zone: "fr-par-1",
          description: "sip ingress",
          tags: ["service=sip"],
          rules: [
            { protocol: "TCP", portRange: { from: 5060, to: 5080 } },
            { protocol: "UDP", portRange: { from: 5060, to: 5080 } },
          ],
        }),
      );
      expect(updated.securityGroupId).toBe(created.securityGroupId);
      expect(updated.description).toBe("sip ingress");
      expect(updated.rules).toHaveLength(2);

      const cleared = yield* stack.deploy(
        Scaleway.SecurityGroup("Firewall", {
          zone: "fr-par-1",
          tags: ["service=sip"],
          rules: [
            { protocol: "TCP", portRange: { from: 5060, to: 5080 } },
            { protocol: "UDP", portRange: { from: 5060, to: 5080 } },
          ],
        }),
      );
      expect(cleared.securityGroupId).toBe(created.securityGroupId);
      expect(cleared.description).toBeUndefined();
      expect(requests("PATCH", "/security_groups/")).toHaveLength(2);
      expect(requests("PUT", "/rules")).toHaveLength(3);
    }),
  );

  test.provider("changing security group zone forces a replace", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(Scaleway.SecurityGroup("Firewall", { zone: "fr-par-1" }));
      const second = yield* stack.deploy(Scaleway.SecurityGroup("Firewall", { zone: "fr-par-2" }));
      expect(second.zone).toBe("fr-par-2");
      expect(second.securityGroupId).not.toBe(first.securityGroupId);
      expect(requests("DELETE", "/security_groups/").length).toBeGreaterThan(0);
    }),
  );

  test.provider("changing security group project forces a replace", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(Scaleway.SecurityGroup("Firewall", { projectId: "project-a" }));
      const second = yield* stack.deploy(Scaleway.SecurityGroup("Firewall", { projectId: "project-b" }));
      expect(second.securityGroupId).not.toBe(first.securityGroupId);
      expect(second.projectId).toBe("project-b");
    }),
  );

  test.provider("read returns existing security groups and ignores missing ones", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Scaleway.SecurityGroup("Firewall", { zone: "fr-par-1", rules: [{ protocol: "TCP", port: 443 }] }),
      );
      const provider = yield* Scaleway.SecurityGroup.Provider.pipe(Effect.provide(vpcLifecycleLayer));
      const read = yield* provider.read!({
        id: "Firewall",
        instanceId: "test",
        olds: { zone: "fr-par-1" },
        output: created,
      });
      expect(read?.securityGroupId).toBe(created.securityGroupId);
      expect(read?.rules).toHaveLength(1);
      expect(requests("GET", "/security_groups/").some((call) => call.url.endsWith("/rules"))).toBe(true);

      mock.removeSecurityGroup(created.securityGroupId);
      const missing = yield* provider.read!({
        id: "Firewall",
        instanceId: "test",
        olds: { zone: "fr-par-1" },
        output: created,
      });
      expect(missing).toBeUndefined();
    }),
  );
});

describe("FlexibleIp", () => {
  test.provider("creates then updates flexible IP metadata and attachment", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Scaleway.FlexibleIp("PublicIp", { zone: "fr-par-1", tags: ["role=edge"], reverse: "edge.example.test" }),
      );
      expect(created.ipId).toMatch(/^ip-/);
      expect(created.address).toMatch(/^203\.0\.113\./);
      expect(created.type).toBe("routed_ipv4");
      expect(created.reverse).toBe("edge.example.test");
      expect(created.tags).toContain("alchemy:logical-id=PublicIp");

      const updated = yield* stack.deploy(
        Scaleway.FlexibleIp("PublicIp", {
          zone: "fr-par-1",
          tags: ["role=sip"],
          serverId: "server-a",
          reverse: "sip.example.test",
        }),
      );
      expect(updated.ipId).toBe(created.ipId);
      expect(updated.serverId).toBe("server-a");
      expect(updated.reverse).toBe("sip.example.test");
      expect(requests("PATCH", "/ips/")).toHaveLength(2);
    }),
  );

  test.provider("changing flexible IP type forces a replace", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(Scaleway.FlexibleIp("PublicIp", { type: "routed_ipv4" }));
      const second = yield* stack.deploy(Scaleway.FlexibleIp("PublicIp", { type: "routed_ipv6" }));
      expect(second.ipId).not.toBe(first.ipId);
      expect(second.type).toBe("routed_ipv6");
    }),
  );

  test.provider("changing flexible IP project forces a replace", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(Scaleway.FlexibleIp("PublicIp", { projectId: "project-a" }));
      const second = yield* stack.deploy(Scaleway.FlexibleIp("PublicIp", { projectId: "project-b" }));
      expect(second.ipId).not.toBe(first.ipId);
      expect(second.projectId).toBe("project-b");
    }),
  );

  test.provider("read returns existing flexible IPs and ignores missing ones", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(Scaleway.FlexibleIp("PublicIp", { zone: "fr-par-1" }));
      const provider = yield* Scaleway.FlexibleIp.Provider.pipe(Effect.provide(vpcLifecycleLayer));
      const read = yield* provider.read!({
        id: "PublicIp",
        instanceId: "test",
        olds: { zone: "fr-par-1" },
        output: created,
      });
      expect(read?.ipId).toBe(created.ipId);

      mock.removeFlexibleIp(created.ipId);
      const missing = yield* provider.read!({
        id: "PublicIp",
        instanceId: "test",
        olds: { zone: "fr-par-1" },
        output: created,
      });
      expect(missing).toBeUndefined();
    }),
  );
});

describe("PrivateNic", () => {
  test.provider("creates then updates private NIC tags", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Scaleway.PrivateNic("Nic", {
          zone: "fr-par-1",
          serverId: "server-a",
          privateNetwork: "pn-a",
          tags: ["role=app"],
        }),
      );
      expect(created.privateNicId).toMatch(/^pnic-/);
      expect(created.serverId).toBe("server-a");
      expect(created.privateNetworkId).toBe("pn-a");
      expect(created.tags).toContain("alchemy:logical-id=Nic");

      const updated = yield* stack.deploy(
        Scaleway.PrivateNic("Nic", {
          zone: "fr-par-1",
          serverId: "server-a",
          privateNetwork: "pn-a",
          tags: ["role=data"],
        }),
      );
      expect(updated.privateNicId).toBe(created.privateNicId);
      expect(updated.tags).toContain("role=data");
      expect(requests("PATCH", "/private_nics/")).toHaveLength(1);
    }),
  );

  test.provider("changing private NIC network forces a replace", (stack) =>
    Effect.gen(function* () {
      const first = yield* stack.deploy(
        Scaleway.PrivateNic("Nic", { serverId: "server-a", privateNetwork: "pn-a" }),
      );
      const second = yield* stack.deploy(
        Scaleway.PrivateNic("Nic", { serverId: "server-a", privateNetwork: "pn-b" }),
      );
      expect(second.privateNicId).not.toBe(first.privateNicId);
      expect(second.privateNetworkId).toBe("pn-b");
      expect(requests("DELETE", "/private_nics/").length).toBeGreaterThan(0);
    }),
  );

  test.provider("read returns existing private NICs and ignores missing ones", (stack) =>
    Effect.gen(function* () {
      const created = yield* stack.deploy(
        Scaleway.PrivateNic("Nic", { zone: "fr-par-1", serverId: "server-a", privateNetwork: "pn-a" }),
      );
      const provider = yield* Scaleway.PrivateNic.Provider.pipe(Effect.provide(vpcLifecycleLayer));
      const read = yield* provider.read!({
        id: "Nic",
        instanceId: "test",
        olds: { zone: "fr-par-1", serverId: "server-a", privateNetwork: "pn-a" },
        output: created,
      });
      expect(read?.privateNicId).toBe(created.privateNicId);

      mock.removePrivateNic(created.serverId, created.privateNicId);
      const missing = yield* provider.read!({
        id: "Nic",
        instanceId: "test",
        olds: { zone: "fr-par-1", serverId: "server-a", privateNetwork: "pn-a" },
        output: created,
      });
      expect(missing).toBeUndefined();
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
