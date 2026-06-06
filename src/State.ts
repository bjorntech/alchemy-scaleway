import { decodeFqn, encodeFqn } from "alchemy/FQN";
import { STATE_STORE_VERSION } from "alchemy/State/HttpStateApi";
import { State, StateStoreError, type PersistedState, type StateService } from "alchemy/State/State";
import { encodeState, reviveState } from "alchemy/State/StateEncoding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ScalewayError } from "./Errors.ts";
import { makeScalewayClients, type ScalewayClients } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";

export interface ObjectStorageStateProps {
  /** Scaleway Object Storage bucket used to persist Alchemy state. Defaults to `alchemy-state-${SCW_DEFAULT_PROJECT_ID}`. */
  bucket?: string;
  /** Object Storage region. Defaults to `SCW_DEFAULT_REGION` / credential region. */
  region?: string;
  /** Key prefix for sharing one bucket across projects/environments. Defaults to `alchemy/state`. */
  prefix?: string;
}

export const state = (props: ObjectStorageStateProps = {}) => objectStorageState(props);

export const objectStorageState = (props: ObjectStorageStateProps = {}) =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const make = makeObjectStorageStateWithClients(props, clients);
      return yield* Effect.cached(make);
    }),
  );

export const makeObjectStorageState = ({ bucket, region, prefix }: ObjectStorageStateProps = {}) =>
  Effect.gen(function* () {
    const clients = yield* makeScalewayClients;
    return yield* makeObjectStorageStateWithClients({ bucket, region, prefix }, clients);
  });

const makeObjectStorageStateWithClients = (
  { bucket, region, prefix }: ObjectStorageStateProps,
  clients: ScalewayClients,
) =>
  Effect.gen(function* () {
    const bucketRegion = region ?? clients.region;
    const bucketName = bucket ?? (clients.projectId ? defaultBucketName(clients.projectId) : undefined);
    const root = rootPrefix(prefix);

    const resourceKey = (request: { stack: string; stage: string; fqn: string }) =>
      `${stagePrefix(root, request.stack, request.stage)}${encodeFqn(request.fqn)}.json`;
    const outputKey = (request: { stack: string; stage: string }) =>
      `${stagePrefix(root, request.stack, request.stage)}__stack_output__.json`;

    const requireBucket: Effect.Effect<string, StateStoreError> = bucketName
      ? Effect.succeed(bucketName)
      : Effect.fail(new StateStoreError({ message: "Scaleway state requires bucket or SCW_DEFAULT_PROJECT_ID." }));

    const ensureBucket: Effect.Effect<string, StateStoreError> = requireBucket.pipe(
      Effect.flatMap((name) =>
        clients.objectStorage.getBucket({ name, region: bucketRegion }).pipe(
          Effect.catchIf(isNotFound, () =>
            clients.objectStorage.createBucket({ name, region: bucketRegion, tags: { "alchemy:state": "true" } }),
          ),
          Effect.as(name),
          Effect.mapError(toStateStoreError),
        ),
      ),
    );

    const withBucket = <A>(
      run: (name: string) => Effect.Effect<A, ScalewayError>,
    ): Effect.Effect<A, StateStoreError> =>
      ensureBucket.pipe(Effect.flatMap(run), Effect.mapError(toStateStoreError));

    const readJson = (key: string) =>
      withBucket((name) => clients.objectStorage.getObject({ bucket: name, region: bucketRegion, key })).pipe(
        Effect.map((body) => (body === undefined ? undefined : JSON.parse(body, reviveState))),
      );

    const writeJson = (key: string, value: unknown) =>
      withBucket((name) => clients.objectStorage.putObject({
          bucket: name,
          region: bucketRegion,
          key,
          body: JSON.stringify(encodeState(value), null, 2),
          contentType: "application/json",
        }));

    const listKeys = (prefix: string) =>
      withBucket((name) => clients.objectStorage.listObjects({ bucket: name, region: bucketRegion, prefix }));

    const service: StateService = {
      id: "scaleway-object-storage",
      getVersion: () => Effect.succeed(STATE_STORE_VERSION),
      listStacks: () =>
        listKeys(root).pipe(Effect.map((keys) => unique(keys.map((key) => key.slice(root.length).split("/")[0]).filter(Boolean)))),
      listStages: (stack) =>
        listKeys(stackPrefix(root, stack)).pipe(
          Effect.map((keys) => unique(keys.map((key) => key.slice(stackPrefix(root, stack).length).split("/")[0]).filter(Boolean))),
        ),
      get: (request) => readJson(resourceKey(request)) as Effect.Effect<PersistedState | undefined, StateStoreError>,
      getReplacedResources: Effect.fnUntraced(function* (request) {
        const fqns = yield* service.list(request);
        const states = yield* Effect.all(
          fqns.map((fqn) => service.get({ ...request, fqn })),
        );
        return states.filter((item): item is Extract<PersistedState, { status: "replaced" }> =>
          (item as { status?: string } | undefined)?.status === "replaced"
        );
      }),
      set: <V extends PersistedState>(request: {
        stack: string;
        stage: string;
        fqn: string;
        value: V;
      }) => writeJson(resourceKey(request), request.value).pipe(Effect.as(request.value)),
      delete: (request) =>
        withBucket((name) =>
          clients.objectStorage.deleteObject({ bucket: name, region: bucketRegion, key: resourceKey(request) }),
        ),
      deleteStack: (request) =>
        Effect.gen(function* () {
          const prefix = request.stage === undefined
            ? stackPrefix(root, request.stack)
            : stagePrefix(root, request.stack, request.stage);
          const name = yield* ensureBucket.pipe(Effect.mapError(toStateStoreError));
          const keys = yield* listKeys(prefix);
          yield* Effect.all(
            keys.map((key) =>
              clients.objectStorage
                .deleteObject({ bucket: name, region: bucketRegion, key })
                .pipe(Effect.mapError(toStateStoreError)),
            ),
          );
        }),
      list: (request) =>
        listKeys(stagePrefix(root, request.stack, request.stage)).pipe(
          Effect.map((keys) =>
            keys
              .map((key) => key.slice(stagePrefix(root, request.stack, request.stage).length))
              .filter((name) => name !== "__stack_output__.json" && name.endsWith(".json"))
              .map((name) => decodeFqn(name.replace(/\.json$/, ""))),
          ),
        ),
      getOutput: (request) => readJson(outputKey(request)),
      setOutput: (request) => writeJson(outputKey(request), request.value).pipe(Effect.as(request.value)),
    };

    return service;
  });

const rootPrefix = (prefix = "alchemy/state") => {
  const trimmed = prefix.replace(/^\/+|\/+$/g, "");
  return trimmed.length === 0 ? "" : `${trimmed}/`;
};

const defaultBucketName = (projectId: string) => `alchemy-state-${projectId.toLowerCase()}`;

const stackPrefix = (root: string, stack: string) => `${root}${stack}/`;
const stagePrefix = (root: string, stack: string, stage: string) => `${stackPrefix(root, stack)}${stage}/`;

const unique = (values: readonly string[]) => [...new Set(values)];

const toStateStoreError = (cause: unknown) =>
  new StateStoreError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause: cause instanceof Error ? cause : undefined,
  });
