import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayProjectRecord } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { omitUndefined, physicalName } from "./Internal.ts";
import type { Providers } from "./Providers.ts";

export interface ProjectProps {
  name?: string;
  organizationId: string;
  description?: string;
}

export type Project = Resource<
  "Scaleway.Project",
  ProjectProps,
  {
    projectId: string;
    name: string;
    organizationId: string;
    description?: string;
    createdAt?: string;
    updatedAt?: string;
  },
  never,
  Providers
>;

export const Project = Resource<Project>("Scaleway.Project");

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const ProjectProvider = () =>
  Provider.effect(
    Project,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const nameOf = (id: string, name?: string) => physicalName(id, name, { maxLength: 64 });
      const isPreconditionError = (error: unknown) => String((error as { message?: unknown })?.message ?? "").toLowerCase().includes("precondition is not respected");
      const toAttributes = (record: ScalewayProjectRecord): Project["Attributes"] =>
        omitUndefined({
          projectId: record.id,
          name: record.name,
          organizationId: record.organization_id,
          description: record.description,
          createdAt: record.created_at,
          updatedAt: record.updated_at,
        }) as Project["Attributes"];

      return Project.Provider.of({
        stables: ["projectId", "organizationId"],
        diff: Effect.fnUntraced(function* ({ id, news, olds, output }) {
          if (!isResolved(news) || !output) return undefined;
          const name = yield* nameOf(id, news.name);
          if (output.organizationId !== news.organizationId) return { action: "replace" } as const;
          if (output.name !== name || olds.description !== news.description) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.projectId) return undefined;
          return yield* clients.account.getProject(output.projectId).pipe(
            Effect.map(toAttributes),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          const name = yield* nameOf(id, news.name);
          if (output?.projectId) {
            const updated = yield* clients.account.updateProject(output.projectId, {
              name,
              organization_id: news.organizationId,
              description: news.description ?? "",
            });
            yield* session.note(`Updated Scaleway project ${output.projectId}`);
            return toAttributes(updated);
          }
          const created = yield* clients.account.createProject({
            name,
            organization_id: news.organizationId,
            description: news.description,
          });
          yield* session.note(`Created Scaleway project ${created.id}`);
          return toAttributes(created);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          while (true) {
            const deleted = yield* clients.account
              .deleteProject(output.projectId)
              .pipe(
                Effect.as(true),
                Effect.catchIf(isNotFound, () => Effect.succeed(true)),
                Effect.catchIf(isPreconditionError, () => Effect.succeed(false)),
              );
            if (deleted) break;
            yield* session.note("waiting project deletion status=precondition");
            yield* Effect.sleep("5 seconds");
          }
          yield* session.note(`Deleted Scaleway project ${output.projectId}`);
        }),
      });
    }),
  );
