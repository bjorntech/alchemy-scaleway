import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ResourceState } from "alchemy/State/ResourceState";
import * as Alchemy from "alchemy";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { State } from "alchemy/State/State";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scaleway from "../src/index.ts";
import { installScalewayMock, type ScalewayMock } from "./support/scaleway-mock.ts";

const credentialsLayer = Layer.succeed(
  Scaleway.ScalewayCredentials,
  Scaleway.ScalewayCredentials.of(Effect.succeed({
    secretKey: Redacted.make("test-secret"),
    accessKey: "test-access",
    region: "fr-par",
    apiUrl: "https://api.scaleway.com",
    projectId: "proj-test",
  })),
);

let mock: ScalewayMock;
beforeEach(() => {
  mock = installScalewayMock();
  mock.seedBucket("alchemy-state", "fr-par");
});
afterEach(() => {
  mock.restore();
});

const resourceState = (logicalId: string, attr: Record<string, unknown>): ResourceState => ({
  resourceType: "Test.Resource",
  namespace: undefined,
  fqn: logicalId,
  logicalId,
  instanceId: `${logicalId}-instance`,
  providerVersion: 1,
  status: "created",
  downstream: [],
  bindings: [],
  props: { name: logicalId },
  attr,
});

const makeState = (prefix?: string) =>
  Scaleway.makeObjectStorageState({ bucket: "alchemy-state", region: "fr-par", prefix }).pipe(
    Effect.provide(Scaleway.ScalewayClientsLive),
    Effect.provide(credentialsLayer),
  );

const makeDefaultState = () =>
  Scaleway.makeObjectStorageState({ region: "fr-par" }).pipe(
    Effect.provide(Scaleway.ScalewayClientsLive),
    Effect.provide(credentialsLayer),
  );

describe("Scaleway Object Storage state", () => {
  test("defaults bucket from project id and creates it when missing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* makeDefaultState();
        yield* state.set({
          stack: "app",
          stage: "prod",
          fqn: "Api",
          value: resourceState("Api", { created: true }),
        });

        const bucketCreates = mock.calls.filter((call) => {
          const url = new URL(call.url);
          return call.method === "PUT" && url.pathname === "/alchemy-state-proj-test/" && url.search === "";
        });
        const objectWrites = mock.calls.filter((call) => {
          const url = new URL(call.url);
          return call.method === "PUT" && url.pathname === "/alchemy-state-proj-test/alchemy/state/app/prod/Api.json";
        });

        expect(bucketCreates).toHaveLength(1);
        expect(objectWrites).toHaveLength(1);
        expect(yield* state.listStacks()).toEqual(["app"]);
      }),
    );
  });

  test("persists resources and stack outputs", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* makeState("alchemy/project-a");
        const value = resourceState("App/Api", { url: "https://example.com" });

        yield* state.set({ stack: "app", stage: "prod", fqn: "App/Api", value });
        yield* state.setOutput({ stack: "app", stage: "prod", value: { api: "https://example.com" } });

        expect(yield* state.listStacks()).toEqual(["app"]);
        expect(yield* state.listStages("app")).toEqual(["prod"]);
        expect(yield* state.list({ stack: "app", stage: "prod" })).toEqual(["App/Api"]);
        expect(yield* state.get({ stack: "app", stage: "prod", fqn: "App/Api" })).toEqual(value);
        expect(yield* state.getOutput({ stack: "app", stage: "prod" })).toEqual({
          api: "https://example.com",
        });
      }),
    );
  });

  test("isolates state by prefix", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* makeState("alchemy/project-a");
        const second = yield* makeState("alchemy/project-b");

        yield* first.set({
          stack: "app",
          stage: "prod",
          fqn: "Api",
          value: resourceState("Api", { project: "a" }),
        });
        yield* second.set({
          stack: "app",
          stage: "prod",
          fqn: "Api",
          value: resourceState("Api", { project: "b" }),
        });

        expect(((yield* first.get({ stack: "app", stage: "prod", fqn: "Api" })) as ResourceState | undefined)?.attr).toEqual({
          project: "a",
        });
        expect(((yield* second.get({ stack: "app", stage: "prod", fqn: "Api" })) as ResourceState | undefined)?.attr).toEqual({
          project: "b",
        });
      }),
    );
  });

  test("deletes one stage without deleting sibling stages", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* makeState("alchemy/project-a");
        yield* state.set({
          stack: "app",
          stage: "dev",
          fqn: "Api",
          value: resourceState("Api", { stage: "dev" }),
        });
        yield* state.setOutput({ stack: "app", stage: "dev", value: { stage: "dev" } });
        yield* state.set({
          stack: "app",
          stage: "prod",
          fqn: "Api",
          value: resourceState("Api", { stage: "prod" }),
        });

        yield* state.deleteStack({ stack: "app", stage: "dev" });

        expect(yield* state.get({ stack: "app", stage: "dev", fqn: "Api" })).toBeUndefined();
        expect(yield* state.getOutput({ stack: "app", stage: "dev" })).toBeUndefined();
        expect(((yield* state.get({ stack: "app", stage: "prod", fqn: "Api" })) as ResourceState | undefined)?.attr).toEqual({
          stage: "prod",
        });
      }),
    );
  });
});

describe("Scaleway.state()", () => {
  const stateLayer = (env: Record<string, string>) =>
    Scaleway.state({ bucket: "alchemy-state", region: "fr-par" }).pipe(
      Layer.provide(Layer.mergeAll(Layer.succeed(AuthProviders, {}),
        Path.layer,
        FileSystem.layerNoop({ makeDirectory: () => Effect.void, chmod: () => Effect.void }),
      )),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    );

  test("brings its own Scaleway credentials, clients and auth provider", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* (yield* State);
        yield* state.set({ stack: "app", stage: "prod", fqn: "Api", value: resourceState("Api", { created: true }) });
        expect(yield* state.listStacks()).toEqual(["app"]);
      }).pipe(
        Effect.provide(stateLayer({ CI: "true", SCW_SECRET_KEY: "secret", SCW_ACCESS_KEY: "access", SCW_DEFAULT_PROJECT_ID: "project" })),
        Effect.scoped,
      ),
    );

    const writes = mock.calls.filter(
      (call) => call.method === "PUT" && new URL(call.url).pathname === "/alchemy-state/alchemy/state/app/prod/Api.json",
    );
    expect(writes).toHaveLength(1);
  });

  test("builds without credentials and resolves them only on first use", async () => {
    const progress = { built: false };
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const resolve = yield* State;
        progress.built = true;
        return yield* resolve;
      }).pipe(Effect.provide(stateLayer({ CI: "true" })), Effect.scoped),
    );

    expect(progress.built).toBe(true);
    expect(mock.calls).toHaveLength(0);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("SCW_SECRET_KEY");
  });

  test("works as a Stack's state on its own", () => {
    const stack = Alchemy.Stack(
      "state-only",
      { providers: Scaleway.providers(), state: Scaleway.state() },
      Effect.succeed({}),
    );
    expect(stack).toBeDefined();
  });
});
