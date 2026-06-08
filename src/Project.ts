import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
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
      const hasAlchemyOwnedFlexibleIp = (projectId: string) =>
        clients.instance.listFlexibleIps({ zone: `${clients.region}-1`, project: projectId }).pipe(
          Effect.map((ips) => ips.some((ip) => (ip.tags ?? []).some((tag) => tag.startsWith("alchemy:logical-id=")))),
          Effect.catchIf(isNotFound, () => Effect.succeed(false)),
        );
      const hasAlchemyOwnedDatabase = (projectId: string) =>
        clients.rdb.listInstances({ region: clients.region, projectId }).pipe(
          Effect.map((instances) => instances.some((instance) => (instance.tags ?? []).some((tag) => tag.startsWith("alchemy:logical-id=")))),
          Effect.catchIf(isNotFound, () => Effect.succeed(false)),
        );
      const hasAlchemyOwnedRetainedResource = (projectId: string) =>
        Effect.gen(function* () {
          return (yield* hasAlchemyOwnedFlexibleIp(projectId)) || (yield* hasAlchemyOwnedDatabase(projectId));
        });
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
        read: Effect.fnUntraced(function* ({ id, olds, output }) {
          if (output?.projectId) {
            return yield* clients.account.getProject(output.projectId).pipe(
              Effect.map(toAttributes),
              Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
            );
          }
          const name = yield* nameOf(id, olds.name);
          const found = yield* clients.account.listProjects({ organizationId: olds.organizationId }).pipe(
            Effect.map((projects) => projects.find((project) => project.name === name && project.organization_id === olds.organizationId)),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
          if (!found) return undefined;
          return (yield* hasAlchemyOwnedRetainedResource(found.id)) ? toAttributes(found) : Unowned(toAttributes(found));
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
            const result = yield* clients.account
              .deleteProject(output.projectId)
              .pipe(
                Effect.as("deleted" as const),
                Effect.catchIf(isNotFound, () => Effect.succeed("deleted" as const)),
                Effect.catchIf(isPreconditionError, () =>
                  hasAlchemyOwnedRetainedResource(output.projectId).pipe(Effect.map((retained) => retained ? "retained" as const : "retry" as const))
                ),
              );
            if (result === "deleted") {
              yield* session.note(`Deleted Scaleway project ${output.projectId}`);
              return;
            }
            if (result === "retained") {
              yield* session.note(`Retained Scaleway project ${output.projectId} because retained resources remain`);
              return;
            }
            yield* session.note("waiting project deletion status=precondition");
            yield* Effect.sleep("5 seconds");
          }
        }),
      });
    }),
  );
