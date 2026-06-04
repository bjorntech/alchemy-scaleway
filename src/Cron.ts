import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { isResolved } from "alchemy/Diff";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayCronRecord } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { omitUndefined, physicalName, resolveRef } from "./Internal.ts";
import type { Container } from "./Container.ts";
import type { Providers } from "./Providers.ts";

export type ContainerRef = string | Container;

export interface CronProps {
  container: ContainerRef;
  schedule: string;
  name?: string;
  args?: Record<string, unknown>;
}

export type Cron = Resource<
  "Scaleway.Cron",
  CronProps,
  {
    cronId: string;
    containerId: string;
    schedule: string;
    name?: string;
    args?: Record<string, unknown>;
  },
  never,
  Providers
>;

export const Cron = Resource<Cron>("Scaleway.Cron");

const argsEqual = (left: Record<string, unknown> | undefined, right: Record<string, unknown> | undefined) =>
  JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});

const containerId = (container: ContainerRef) => {
  return resolveRef(typeof container === "string" ? container : container.containerId);
};

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const CronProvider = () =>
  Provider.effect(
    Cron,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const nameOf = (id: string, name?: string) => physicalName(id, name, { maxLength: 63 });
      const toAttributes = (record: ScalewayCronRecord): Cron["Attributes"] =>
        omitUndefined({ cronId: record.id, containerId: record.container_id, schedule: record.schedule, name: record.name, args: record.args }) as Cron["Attributes"];
      const waitForReady = (cronIdValue: string, attempts = 20): Effect.Effect<Cron["Attributes"], unknown> =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < attempts; attempt++) {
            const record = yield* clients.containers.getCron(cronIdValue);
            const status = record.status?.toLowerCase();
            if (!status || status === "ready") return toAttributes(record);
            if (status === "error") throw new Error(`Scaleway cron ${cronIdValue} entered error state`);
            yield* Effect.sleep("1 second");
          }
          throw new Error(`Timed out waiting for Scaleway cron ${cronIdValue}`);
        });

      return Cron.Provider.of({
        stables: ["cronId", "containerId", "schedule"],
        diff: Effect.fnUntraced(function* ({ id, news, olds, output }) {
          if (!isResolved(news) || !output) return undefined;
          const resolvedContainerId = yield* containerId(news.container);
          if (resolvedContainerId !== output.containerId) return { action: "replace" } as const;
          const name = yield* nameOf(id, news.name);
          if (output.name !== name || olds.schedule !== news.schedule || !argsEqual(olds.args, news.args)) return { action: "update" } as const;
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.cronId) return undefined;
          return yield* clients.containers.getCron(output.cronId).pipe(
            Effect.map(toAttributes),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          const resolvedContainerId = yield* containerId(news.container);
          const body = {
            ...omitUndefined({ name: yield* nameOf(id, news.name), args: news.args }),
            container_id: resolvedContainerId,
            schedule: news.schedule,
          };
          if (output?.cronId) {
            const updated = yield* clients.containers.updateCron(output.cronId, body);
            yield* session.note(`Updated Scaleway cron ${output.cronId}`);
            return updated.status?.toLowerCase() === "ready" ? toAttributes(updated) : yield* waitForReady(output.cronId);
          }
          const created = yield* clients.containers.createCron(body);
          yield* session.note(`Created Scaleway cron ${created.id}`);
          return yield* waitForReady(created.id);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.containers.deleteCron(output.cronId).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway cron ${output.cronId}`);
        }),
      });
    }),
  );
