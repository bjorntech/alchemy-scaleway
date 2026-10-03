import { describe, expect, test } from "bun:test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Interaction from "alchemy/Interaction";
import { AuthProviders, type AuthProvider } from "alchemy/Auth/AuthProvider";
import { CredentialsStore, type CredentialsStoreService } from "alchemy/Auth/Credentials";
import { CredentialsUnavailable } from "alchemy/Auth/Resolve";
import { ScalewayAuth, type ScalewayResolvedCredentials } from "../src/AuthProvider.ts";
import { fromAuthProvider, ScalewayCredentials } from "../src/Credentials.ts";

const credentials = {
  secretKey: "stored-secret",
  accessKey: "stored-access",
  projectId: "project",
  region: "fr-par",
};

const makeStore = (counts: { reads: number; prompts: number }) =>
  ({
    read: <A, _E>() =>
      Effect.sync(() => {
        counts.reads += 1;
        return credentials as A;
      }),
    write: () => Effect.void,
    delete: () => Effect.void,
    deleteProfile: () => Effect.void,
  }) satisfies CredentialsStoreService;

const makeInteraction = (counts: { prompts: number }) =>
  Interaction.Interaction.of({
    output: {
      info: () => Effect.void,
      success: () => Effect.void,
      warning: () => Effect.void,
      error: () => Effect.void,
    },
    prompt: {
      password: () =>
        Effect.sync(() => {
          counts.prompts += 1;
          return "secret";
        }),
      text: () =>
        Effect.sync(() => {
          counts.prompts += 1;
          return "value";
        }),
      confirm: () => Effect.succeed(true),
      select: (() =>
        Effect.succeed("env")) as Interaction.Interaction["Service"]["prompt"]["select"],
      multiSelect: () => Effect.succeed([]),
      awaitExternal: () => Effect.succeed("done"),
    },
    task: (_options, effect) => effect,
  });

const makeLayer = (options: {
  store: CredentialsStoreService;
  env?: Record<string, string>;
  promptCounts?: { prompts: number };
}) => {
  const registry: Record<string, AuthProvider> = {};
  const authLayer = ScalewayAuth.pipe(
    Layer.provide(Layer.succeed(CredentialsStore, options.store)),
    Layer.provideMerge(Layer.succeed(AuthProviders, registry)),
  );
  let services = Layer.mergeAll(fromAuthProvider(), authLayer).pipe(
    Layer.provideMerge(Layer.succeed(CredentialsStore, options.store)),
    Layer.provideMerge(Layer.succeed(AuthProviders, registry)),
    Layer.provideMerge(
      Layer.succeed(
        Interaction.Interaction,
        makeInteraction(options.promptCounts ?? { prompts: 0 }),
      ),
    ),
  );
  return options.env === undefined
    ? services.pipe(Layer.provideMerge(Path.layer), Layer.provideMerge(FileSystem.layerNoop({})))
    : services.pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: options.env }))),
        Layer.provideMerge(Path.layer),
        Layer.provideMerge(FileSystem.layerNoop({})),
      );
};

const getCredentials = (context: Context.Context<unknown>) =>
  Context.get(context, ScalewayCredentials);

const build = (layer: Layer.Layer<any, any, any>) =>
  Effect.scoped(Layer.build(layer)) as Effect.Effect<Context.Context<any>, never, never>;

const defects = (cause: Cause.Cause<unknown>) =>
  cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect);

const makeResolverLayer = (reads: { count: number }) => {
  const auth = {
    kind: "AuthProvider" as const,
    name: "Scaleway",
    configSchema: {} as never,
    configure: () => Effect.die("unused"),
    login: () => Effect.die("unused"),
    logout: () => Effect.die("unused"),
    details: () => Effect.die("unused"),
    read: () => Effect.die("unused"),
    readEnvironment: Effect.sync(() => {
      reads.count += 1;
      return {
        method: "env" as const,
        accessKey: "access",
        secretKey: Redacted.make("secret"),
        projectId: "project",
        region: "fr-par",
        apiUrl: "https://api.scaleway.com",
        source: { type: "env" as const },
      } satisfies ScalewayResolvedCredentials;
    }),
    environment: [{ name: "SCW_SECRET_KEY", required: true, secret: true }],
    logEnvironmentCredentials: () => Effect.void,
    decodeConfig: () => Effect.die("unused"),
  } as AuthProvider;
  const registry = { Scaleway: auth };
  return fromAuthProvider().pipe(
    Layer.provideMerge(Layer.succeed(AuthProviders, registry)),
    Layer.provideMerge(Path.layer),
    Layer.provideMerge(FileSystem.layerNoop({})),
    Layer.provide(
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: { SCW_SECRET_KEY: "present" } })),
    ),
  );
};

describe("Scaleway beta80 credential lifecycle", () => {
  test("builds without reading credentials or prompting", async () => {
    const counts = { reads: 0, prompts: 0 };
    const context = await Effect.runPromise(
      build(
        makeLayer({
          store: makeStore(counts),
          env: { CI: "true" },
          promptCounts: counts,
        }),
      ),
    );

    expect(counts).toEqual({ reads: 0, prompts: 0 });
    const result = await Effect.runPromiseExit(
      getCredentials(context).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { CI: "true" } }))),
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(counts).toEqual({ reads: 0, prompts: 0 });
  });

  test("resolves environment credentials once for concurrent and repeated use", async () => {
    const reads = { count: 0 };
    const context = await Effect.runPromise(build(makeResolverLayer(reads)));
    const resolver = getCredentials(context);
    const results = await Effect.runPromise(
      Effect.all([resolver, resolver, resolver], { concurrency: "unbounded" }),
    );

    expect(results.map((value) => value.region)).toEqual(["fr-par", "fr-par", "fr-par"]);
    expect(reads).toEqual({ count: 1 });
    expect(Redacted.value(results[0]!.secretKey)).toBe("secret");
  });

  test("fails first use with CredentialsUnavailable", async () => {
    const context = await Effect.runPromise(
      build(
        makeLayer({
          store: makeStore({ reads: 0, prompts: 0 }),
          env: { CI: "true" },
        }),
      ),
    );
    const result = await Effect.runPromiseExit(
      getCredentials(context).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { CI: "true" } }))),
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const found = defects(result.cause);
      expect(found[0]).toBeInstanceOf(CredentialsUnavailable);
      expect((found[0] as CredentialsUnavailable)._tag).toBe("CredentialsUnavailable");
    }
  });

  test("rejects an empty secret through deferred environment resolution", async () => {
    const context = await Effect.runPromise(
      build(
        makeLayer({
          store: makeStore({ reads: 0, prompts: 0 }),
          env: { CI: "true", SCW_SECRET_KEY: "" },
        }),
      ),
    );
    const result = await Effect.runPromiseExit(
      getCredentials(context).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { CI: "true", SCW_SECRET_KEY: "" } })),
        ),
      ),
    );

    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(defects(result.cause)[0]).toBeInstanceOf(CredentialsUnavailable);
    }
  });
});
