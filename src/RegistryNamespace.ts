import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { isResolved } from "alchemy/Diff";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayRegistryNamespaceRecord } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { omitUndefined, physicalName, projectId, projectInput, withManagedProjectDefault, type ProjectRef } from "./Internal.ts";
import type { Providers } from "./Providers.ts";

export interface RegistryNamespaceProps {
  name?: string;
  project?: ProjectRef;
  description?: string;
  public?: boolean;
}

export type RegistryNamespace = Resource<
  "Scaleway.RegistryNamespace",
  RegistryNamespaceProps,
  {
    registryNamespaceId: string;
    name: string;
    projectId: string;
    region: string;
    description?: string;
    public?: boolean;
    endpoint?: string;
    imagePrefix?: string;
    status?: string;
  },
  never,
  Providers
>;

export const RegistryNamespace = withManagedProjectDefault(Resource<RegistryNamespace>("Scaleway.RegistryNamespace"));

class RegistryNamespaceFailed extends Data.TaggedError("Scaleway.RegistryNamespaceFailed")<{
  registryNamespaceId: string;
  status: string;
}> {}

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const RegistryNamespaceProvider = () =>
  Provider.effect(
    RegistryNamespace,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const nameOf = (id: string, name?: string) => physicalName(id, name, { maxLength: 63 });
      const toAttributes = (
        record: ScalewayRegistryNamespaceRecord,
      ): RegistryNamespace["Attributes"] =>
        omitUndefined({
          registryNamespaceId: record.id,
          name: record.name,
          projectId: record.project_id,
          region: clients.region,
          description: record.description,
          public: record.is_public,
          endpoint: record.endpoint,
          imagePrefix: record.endpoint,
          status: record.status,
        }) as RegistryNamespace["Attributes"];

      const waitForReady = (
        registryNamespaceId: string,
        attempts = 20,
      ): Effect.Effect<RegistryNamespace["Attributes"], unknown> =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < attempts; attempt++) {
            const record = yield* clients.registry.getNamespace(registryNamespaceId);
            const status = record.status?.toLowerCase();
            if (!status || status === "ready") return toAttributes(record);
            if (status === "error" || status === "locked") {
              return yield* new RegistryNamespaceFailed({
                registryNamespaceId,
                status: record.status ?? "unknown",
              });
            }
            yield* Effect.sleep("1 second");
          }
          throw new Error(
            `Timed out waiting for Scaleway registry namespace ${registryNamespaceId}`,
          );
        });

      return RegistryNamespace.Provider.of({
        stables: ["registryNamespaceId", "projectId", "region"],
        diff: Effect.fnUntraced(function* ({ id, news, olds, output }) {
          if (!isResolved(news) || !output) return undefined;
          const resolvedProjectId = yield* projectId(projectInput(news), output.projectId);
          if (resolvedProjectId !== output.projectId) return { action: "replace" } as const;
          const name = yield* nameOf(id, news.name);
          if (name !== output.name) return { action: "replace" } as const;
          if (olds.description !== news.description || olds.public !== news.public) {
            return { action: "update" } as const;
          }
          return { action: "noop" } as const;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.registryNamespaceId) return undefined;
          return yield* clients.registry.getNamespace(output.registryNamespaceId).pipe(
            Effect.map(toAttributes),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          const name = yield* nameOf(id, news.name);
          if (output?.registryNamespaceId) {
            const updated = yield* clients.registry.updateNamespace(output.registryNamespaceId, {
              description: news.description,
              is_public: news.public,
            });
            yield* session.note(
              `Updated Scaleway registry namespace ${output.registryNamespaceId}`,
            );
            return updated.status?.toLowerCase() === "ready"
              ? toAttributes(updated)
              : yield* waitForReady(output.registryNamespaceId);
          }
          const created = yield* clients.registry.createNamespace({
            name,
            project_id: yield* projectId(projectInput(news), output?.projectId),
            description: news.description,
            is_public: news.public,
          });
          yield* session.note(`Created Scaleway registry namespace ${created.id}`);
          return created.status?.toLowerCase() === "ready"
            ? toAttributes(created)
            : yield* waitForReady(created.id);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.registry
            .deleteNamespace(output.registryNamespaceId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway registry namespace ${output.registryNamespaceId}`);
        }),
      });
    }),
  );
