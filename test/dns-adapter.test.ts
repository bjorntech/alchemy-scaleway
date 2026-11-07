import { afterEach, beforeEach, describe, expect } from "bun:test";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Output from "alchemy/Output";
import * as Test from "@alchemy.run/test/Bun";
import { resolve, DnsAdapterError } from "alchemy/DNS/Adapter";
import * as Scaleway from "../src/index.ts";
import { installScalewayMock, type ScalewayMock } from "./support/scaleway-mock.ts";
import { testProviders } from "./support/test-providers.ts";

const { test } = Test.make({ providers: testProviders() });
let mock: ScalewayMock;

const calls = (method: string) =>
  mock.calls.filter((call) => call.method === method && call.url.includes("/dns-zones/"));

describe("Scaleway shared DNS adapter", () => {
  beforeEach(() => {
    mock = installScalewayMock();
  });
  afterEach(() => mock.restore());

  test.provider("returns serializable config and resolves the registered adapter", () =>
    Effect.gen(function* () {
      const config = Scaleway.DNS.Adapter({
        zone: Output.literal("example.test"),
        project: "proj-dns",
      });
      expect(config).toEqual({
        type: "Scaleway.DNS",
        zone: config.zone,
        options: { zone: config.zone, project: "proj-dns" },
      });
      const adapter = yield* resolve(config);
      expect(adapter.alias).toBeFunction();
      expect(adapter.aliasSet).toBeFunction();
      expect(adapter.records).toBeFunction();
    }),
  );

  test.provider("declares aliases, deferred values, and bindable alias sets", (stack) =>
    Effect.gen(function* () {
      mock.seedDnsZone("example.test", "proj-dns");
      const result = (yield* stack.deploy(
        Effect.gen(function* () {
          const adapter = yield* resolve(
            Scaleway.DNS.Adapter({ zone: "example.test", project: "proj-dns" }),
          );
          yield* adapter.alias("web", {
            name: "www",
            target: { hostname: Output.literal("origin.example.net") },
          });
          const records = yield* adapter.aliasSet("set", {
            target: { hostname: "origin.example.net" },
            names: ["one.example.test"],
          });
          yield* records.bind("bound", { names: ["two.example.test"] });
          return yield* adapter.records("addresses", {
            records: Output.literal([
              { name: "edge.example.test", type: "A", value: "192.0.2.10" },
              { name: "edge.example.test", type: "AAAA", value: "2001:db8::10" },
            ]),
          });
        }),
      )) as Scaleway.DnsRecordListResource["Attributes"];
      expect(result.dnsZone).toBe("example.test");
      const patches = calls("PATCH");
      expect(patches.length).toBeGreaterThanOrEqual(4);
      expect(patches.some((call) => call.body.includes("origin.example.net"))).toBe(true);
      expect(patches.some((call) => call.body.includes("192.0.2.10"))).toBe(true);
      expect(patches.some((call) => call.body.includes("2001:db8::10"))).toBe(true);
      expect(patches.some((call) => call.body.includes('"name":"two"'))).toBe(true);
    }),
  );

  test.provider("updates and removes owned sets, while retain leaves them intact", (stack) =>
    Effect.gen(function* () {
      mock.seedDnsZone("example.test", "proj-test");
      yield* stack.deploy(
        Effect.gen(function* () {
          const adapter = yield* resolve(Scaleway.DNS.Adapter({ zone: "example.test" }));
          return yield* adapter.records("owned", {
            records: [{ name: "api", type: "A", value: "192.0.2.1" }],
          });
        }),
      );
      const beforeDelete = calls("PATCH").length;
      yield* stack.deploy(
        Effect.gen(function* () {
          const adapter = yield* resolve(Scaleway.DNS.Adapter({ zone: "example.test" }));
          return yield* adapter.records("owned", {
            records: [{ name: "api", type: "A", value: "192.0.2.2" }],
          });
        }),
      );
      expect(calls("PATCH").length).toBeGreaterThan(beforeDelete);
      yield* stack.destroy();
      expect(calls("PATCH").at(-1)?.body).toContain('"delete"');
    }),
  );

  test.provider("persists retain and does not delete retained records", (stack) =>
    Effect.gen(function* () {
      mock.seedDnsZone("example.test", "proj-test");
      yield* stack.deploy(
        Effect.gen(function* () {
          const adapter = yield* resolve(Scaleway.DNS.Adapter({ zone: "example.test" }));
          return yield* adapter.records("retained", {
            retain: true,
            records: [{ name: "keep", type: "A", value: "192.0.2.30" }],
          });
        }),
      );
      const before = calls("PATCH").length;
      yield* stack.destroy();
      expect(
        calls("PATCH")
          .slice(before)
          .every((call) => !call.body.includes('"delete"')),
      ).toBe(true);
    }),
  );

  test.provider("rejects cold collisions, apex CNAMEs, and Route 53 aliases", (stack) =>
    Effect.gen(function* () {
      mock.seedDnsZone("example.test", "proj-test");
      mock.seedDnsRecord({
        dnsZone: "example.test",
        name: "api",
        type: "CNAME",
        data: "old.example.net",
      });
      mock.seedDnsRecord({
        dnsZone: "example.test",
        name: "same",
        type: "A",
        data: "192.0.2.9",
      });
      const collision = yield* Effect.exit(
        stack.deploy(
          Effect.gen(function* () {
            const adapter = yield* resolve(Scaleway.DNS.Adapter({ zone: "example.test" }));
            return yield* adapter.alias("collision", {
              name: "api",
              target: { hostname: "origin.example.net" },
            });
          }),
        ),
      );
      expect(Exit.isFailure(collision)).toBe(true);
      const apex = yield* Effect.exit(
        stack.deploy(
          Effect.gen(function* () {
            const adapter = yield* resolve(Scaleway.DNS.Adapter({ zone: "example.test" }));
            return yield* adapter.alias("apex", {
              name: "@",
              target: { hostname: "origin.example.net" },
            });
          }),
        ),
      );
      expect(Exit.isFailure(apex)).toBe(true);
      const route53 = yield* Effect.exit(
        stack.deploy(
          Effect.gen(function* () {
            const adapter = yield* resolve(Scaleway.DNS.Adapter({ zone: "example.test" }));
            return yield* adapter.alias("route53", {
              name: "www",
              target: { hostname: "origin.example.net", route53Alias: { hostedZoneId: "Z" } },
            });
          }),
        ),
      );
      expect(Exit.isFailure(route53)).toBe(true);
      const beforeIdentical = calls("PATCH").length;
      const identical = yield* Effect.exit(
        stack.deploy(
          Effect.gen(function* () {
            const adapter = yield* resolve(Scaleway.DNS.Adapter({ zone: "example.test" }));
            return yield* adapter.records("identical", {
              records: [{ name: "same", type: "A", value: "192.0.2.9" }],
            });
          }),
        ),
      );
      expect(Exit.isFailure(identical)).toBe(true);
      expect(calls("PATCH").length).toBe(beforeIdentical);
    }),
  );

  test.provider("infers the most-specific zone and rejects ambiguous inference", (stack) =>
    Effect.gen(function* () {
      mock.seedDnsZone("example.test", "proj-dns");
      mock.seedDnsZone("dev.example.test", "proj-dns");
      const specific = (yield* stack.deploy(
        Effect.gen(function* () {
          const adapter = yield* resolve(Scaleway.DNS.Adapter({ project: "proj-dns" }));
          return yield* adapter.records("specific", {
            records: [{ name: "api.dev.example.test", type: "A", value: "192.0.2.20" }],
          });
        }),
      )) as Scaleway.DnsRecordListResource["Attributes"];
      expect(specific.dnsZone).toBe("dev.example.test");
      mock.seedDnsZone("dev.example.test", "other-project");
      const duplicateExplicit = yield* Effect.exit(
        stack.deploy(
          Effect.gen(function* () {
            const adapter = yield* resolve(Scaleway.DNS.Adapter({ zone: "dev.example.test" }));
            return yield* adapter.records("duplicate-explicit", {
              records: [{ name: "dup", type: "A", value: "192.0.2.22" }],
            });
          }),
        ),
      );
      expect(Exit.isFailure(duplicateExplicit)).toBe(true);
      const ambiguous = yield* Effect.exit(
        stack.deploy(
          Effect.gen(function* () {
            const adapter = yield* resolve(Scaleway.DNS.Adapter({}));
            return yield* adapter.records("ambiguous", {
              records: [{ name: "www.dev.example.test", type: "A", value: "192.0.2.21" }],
            });
          }),
        ),
      );
      expect(Exit.isFailure(ambiguous)).toBe(true);
    }),
  );

  test.provider("persists independent groups across zones and removes only stale groups", (stack) =>
    Effect.gen(function* () {
      mock.seedDnsZone("example.test", "proj-test");
      mock.seedDnsZone("other.test", "proj-test");
      yield* stack.deploy(
        Effect.gen(function* () {
          const adapter = yield* resolve(Scaleway.DNS.Adapter({ project: "proj-test" }));
          return yield* adapter.records("multi", {
            records: Output.literal([
              { name: "api.example.test", type: "A", value: "192.0.2.40" },
              { name: "api.example.test", type: "AAAA", value: "2001:db8::40" },
              { name: "api.other.test", type: "A", value: "192.0.2.41" },
            ]),
          });
        }),
      );
      const firstPatches = calls("PATCH").length;
      yield* stack.deploy(
        Effect.gen(function* () {
          const adapter = yield* resolve(Scaleway.DNS.Adapter({ project: "proj-test" }));
          return yield* adapter.records("multi", {
            records: [{ name: "api.example.test", type: "A", value: "192.0.2.42" }],
          });
        }),
      );
      expect(calls("PATCH").length).toBeGreaterThan(firstPatches);
      const recent = calls("PATCH")
        .slice(firstPatches)
        .map((call) => call.body)
        .join("\n");
      expect(recent).toContain('"type":"AAAA"');
      expect(recent).not.toContain('"dnsZone":"other.test"');
    }),
  );

  test.provider("fails closed after a partial multi-group write", (stack) =>
    Effect.gen(function* () {
      mock.seedDnsZone("example.test", "proj-test");
      mock.seedDnsRecord({
        dnsZone: "example.test",
        name: "b",
        type: "A",
        data: "192.0.2.99",
      });
      const first = yield* Effect.exit(
        stack.deploy(
          Effect.gen(function* () {
            const adapter = yield* resolve(Scaleway.DNS.Adapter({ zone: "example.test" }));
            return yield* adapter.records("retry", {
              records: [
                { name: "a", type: "A", value: "192.0.2.50" },
                { name: "b", type: "A", value: "192.0.2.51" },
              ],
            });
          }),
        ),
      );
      expect(Exit.isFailure(first)).toBe(true);
      const patchesAfterFirst = calls("PATCH").length;
      expect(calls("PATCH").some((call) => call.body.includes('"name":"a"'))).toBe(true);
      const second = yield* Effect.exit(stack.deploy(
        Effect.gen(function* () {
          const adapter = yield* resolve(Scaleway.DNS.Adapter({ zone: "example.test" }));
          return yield* adapter.records("retry", {
            records: [
              { name: "a", type: "A", value: "192.0.2.50" },
              { name: "b", type: "A", value: "192.0.2.51" },
            ],
          });
        }),
      ));
      expect(Exit.isFailure(second)).toBe(true);
      expect(calls("PATCH").length).toBe(patchesAfterFirst);
    }),
  );

  test.provider("rejects persisted authority changes before writing", (stack) =>
    Effect.gen(function* () {
      mock.seedDnsZone("example.test", "proj-test");
      mock.seedDnsZone("example.test", "proj-other");
      yield* stack.deploy(
        Effect.gen(function* () {
          const adapter = yield* resolve(
            Scaleway.DNS.Adapter({ zone: "example.test", project: "proj-test" }),
          );
          return yield* adapter.records("authority", {
            records: [{ name: "api", type: "A", value: "192.0.2.60" }],
          });
        }),
      );
      const before = calls("PATCH").length;
      const result = yield* Effect.exit(
        stack.deploy(
          Effect.gen(function* () {
            const adapter = yield* resolve(
              Scaleway.DNS.Adapter({ zone: "example.test", project: "proj-other" }),
            );
            return yield* adapter.records("authority", {
              records: [{ name: "api", type: "A", value: "192.0.2.61" }],
            });
          }),
        ),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(calls("PATCH").length).toBe(before);
    }),
  );

  test.provider(
    "supports multi-label relative names and rejects absolute names outside the zone",
    (stack) =>
      Effect.gen(function* () {
        mock.seedDnsZone("example.test", "proj-test");
        yield* stack.deploy(
          Effect.gen(function* () {
            const adapter = yield* resolve(Scaleway.DNS.Adapter({ zone: "example.test" }));
            return yield* adapter.records("relative", {
              records: [{ name: "api.internal", type: "A", value: "192.0.2.70" }],
            });
          }),
        );
        const result = yield* Effect.exit(
          stack.deploy(
            Effect.gen(function* () {
              const adapter = yield* resolve(Scaleway.DNS.Adapter({ zone: "example.test" }));
              return yield* adapter.records("outside", {
                records: [{ name: "outside.invalid.", type: "A", value: "192.0.2.71" }],
              });
            }),
          ),
        );
        expect(Exit.isFailure(result)).toBe(true);
      }),
  );

  test.provider("allows an empty alias set and later binds names", (stack) =>
    Effect.gen(function* () {
      mock.seedDnsZone("example.test", "proj-test");
      yield* stack.deploy(
        Effect.gen(function* () {
          const adapter = yield* resolve(Scaleway.DNS.Adapter({ zone: "example.test" }));
          yield* adapter.aliasSet("empty", { target: { hostname: "origin.example.net" } });
          return {};
        }),
      );
      const before = calls("PATCH").length;
      yield* stack.deploy(
        Effect.gen(function* () {
          const adapter = yield* resolve(Scaleway.DNS.Adapter({ zone: "example.test" }));
          const set = yield* adapter.aliasSet("empty", {
            target: { hostname: "origin.example.net" },
          });
          yield* set.bind("name", { names: ["bound.example.test"] });
          return {};
        }),
      );
      expect(calls("PATCH").length).toBeGreaterThan(before);
    }),
  );
});
