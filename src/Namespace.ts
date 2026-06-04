import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { isResolved } from "alchemy/Diff";
import * as Effect from "effect/Effect";
import { makeScalewayClients } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { omitUndefined, physicalName, projectId, recordEquals } from "./Internal.ts";
import type { Providers } from "./Providers.ts";

export interface NamespaceProps {
  name?: string;
  projectId?: string;
  description?: string;
  environmentVariables?: Record<string, string>;
}

export type Namespace = Resource<
  "Scaleway.Namespace",
  NamespaceProps,
  {
    namespaceId: string;
    name: string;
    projectId: string;
    region: string;
    description?: string;
    environmentVariables?: Record<string, string>;
  },
  never,
  Providers
>;

export const Namespace = Resource<Namespace>("Scaleway.Namespace");

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const NamespaceProvider = () =>
  Provider.effect(
    Namespace,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;

      const nameOf = (id: string, name?: string) => physicalName(id, name, { maxLength: 63 });
      const toAttributes = (record: {
        id: string;
        name: string;
        project_id: string;
        description?: string;
        environment_variables?: Record<string, string>;
      }): Namespace["Attributes"] =>
        omitUndefined({
          namespaceId: record.id,
          name: record.name,
          projectId: record.project_id,
          region: clients.region,
          description: record.description,
          environmentVariables: record.environment_variables,
        }) as Namespace["Attributes"];

      return Namespace.Provider.of({
        stables: ["namespaceId", "projectId", "region"],
        diff: Effect.fnUntraced(function* ({ id, news, olds, output }) {
          if (!isResolved(news) || !output) return undefined;
          const name = yield* nameOf(id, news.name);
          const resolvedProjectId = yield* projectId(news.projectId);
          if (resolvedProjectId !== output.projectId) return { action: "replace" } as const;
          if (
            output.name !== name ||
            olds.description !== news.description ||
            !recordEquals(olds.environmentVariables, news.environmentVariables)
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.namespaceId) return undefined;
          return yield* clients.containers.getNamespace(output.namespaceId).pipe(
            Effect.map(toAttributes),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          const name = yield* nameOf(id, news.name);
          const resolvedProjectId = yield* projectId(news.projectId);
          const body = omitUndefined({
            name,
            description: news.description,
            environment_variables: news.environmentVariables,
          });
          if (output?.namespaceId) {
            const updated = yield* clients.containers.updateNamespace(output.namespaceId, body);
            yield* session.note(`Updated Scaleway namespace ${output.namespaceId}`);
            return toAttributes(updated);
          }
          const created = yield* clients.containers.createNamespace({
            ...body,
            name,
            project_id: resolvedProjectId,
          });
          yield* session.note(`Created Scaleway namespace ${created.id}`);
          return toAttributes(created);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.containers.deleteNamespace(output.namespaceId).pipe(
            Effect.catchIf(isNotFound, () => Effect.void),
          );
          yield* session.note(`Deleted Scaleway namespace ${output.namespaceId}`);
        }),
      });
    }),
  );
