import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayFunctionCronRecord } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { omitUndefined, physicalName, resolveRef } from "./Internal.ts";
import type { Function as ScalewayFunction } from "./Function.ts";
import type { Providers } from "./Providers.ts";

export type FunctionCronRef = string | ScalewayFunction;

export interface FunctionCronProps {
  function: FunctionCronRef;
  schedule: string;
  args?: Record<string, unknown>;
  name?: string;
}

export type FunctionCron = Resource<
  "Scaleway.FunctionCron",
  FunctionCronProps,
  { cronId: string; functionId: string; schedule: string; args?: Record<string, unknown>; name?: string; status?: string },
  never,
  Providers
>;

export const FunctionCron = Resource<FunctionCron>("Scaleway.FunctionCron");

function functionId(func: FunctionCronRef) {
  return resolveRef(typeof func === "string" ? func : func.functionId);
}

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const FunctionCronProvider = () =>
  Provider.effect(
    FunctionCron,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const nameOf = (id: string, name?: string) => physicalName(id, name, { maxLength: 63 });
      const toAttributes = (record: ScalewayFunctionCronRecord): FunctionCron["Attributes"] =>
        omitUndefined({
          cronId: record.id,
          functionId: record.function_id,
          schedule: record.schedule,
          args: record.args,
          name: record.name,
          status: record.status,
        }) as FunctionCron["Attributes"];
      const waitForReady = (cronIdValue: string, session: { note(message: string): Effect.Effect<void> }) =>
        Effect.gen(function* () {
          while (true) {
            const record = yield* clients.functions.getCron(cronIdValue);
            const status = record.status?.toLowerCase();
            if (!status || status === "ready") return toAttributes(record);
            if (status === "error") throw new Error(`Scaleway function cron ${cronIdValue} entered error state`);
            yield* session.note(`waiting function cron ready status=${record.status ?? "unknown"}`);
            yield* Effect.sleep("1 second");
          }
        });

      return FunctionCron.Provider.of({
        stables: ["cronId", "functionId"],
        diff: Effect.fnUntraced(function* ({ id, news, olds, output }) {
          if (!isResolved(news) || !output) return undefined;
          if ((yield* functionId(news.function)) !== output.functionId) return { action: "replace" } as const;
          const name = yield* nameOf(id, news.name);
          if (output.schedule !== news.schedule || output.name !== name || JSON.stringify(olds.args ?? {}) !== JSON.stringify(news.args ?? {})) return { action: "update" } as const;
          return { action: "noop" } as const;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.cronId) return undefined;
          return yield* clients.functions.getCron(output.cronId).pipe(
            Effect.map(toAttributes),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          const input = omitUndefined({
            function_id: yield* functionId(news.function),
            schedule: news.schedule,
            args: news.args,
            name: yield* nameOf(id, news.name),
          });
          if (output?.cronId) {
            const updated = yield* clients.functions.updateCron(output.cronId, input);
            yield* session.note(`Updated Scaleway function cron ${output.cronId}`);
            return updated.status?.toLowerCase() === "ready" ? toAttributes(updated) : yield* waitForReady(output.cronId, session);
          }
          const created = yield* clients.functions.createCron(input);
          yield* session.note(`Created Scaleway function cron ${created.id}`);
          return created.status?.toLowerCase() === "ready" ? toAttributes(created) : yield* waitForReady(created.id, session);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.functions
            .deleteCron(output.cronId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway function cron ${output.cronId}`);
        }),
      });
    }),
  );
