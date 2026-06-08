import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayFunctionDomainRecord } from "./Clients.ts";
import { isNotFound, ScalewayError } from "./Errors.ts";
import { omitUndefined, resolveRef } from "./Internal.ts";
import type { Function as ScalewayFunction } from "./Function.ts";
import type { Providers } from "./Providers.ts";

export type FunctionRef = string | ScalewayFunction;

export interface FunctionDomainProps {
  function: FunctionRef;
  hostname: string;
}

export type FunctionDomain = Resource<
  "Scaleway.FunctionDomain",
  FunctionDomainProps,
  { domainId: string; functionId: string; hostname: string; url?: string },
  never,
  Providers
>;

export const FunctionDomain = Resource<FunctionDomain>("Scaleway.FunctionDomain");

function functionId(func: FunctionRef) {
  return resolveRef(typeof func === "string" ? func : func.functionId);
}

function isResourceAlreadyExists(error: unknown) {
  return error instanceof ScalewayError && error.statusCode === 409 && error.message.toLowerCase().includes("resource already exists");
}

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const FunctionDomainProvider = () =>
  Provider.effect(
    FunctionDomain,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const toAttributes = (record: ScalewayFunctionDomainRecord): FunctionDomain["Attributes"] =>
        omitUndefined({
          domainId: record.id,
          functionId: record.function_id,
          hostname: record.hostname,
          url: record.url ?? `https://${record.hostname}`,
        }) as FunctionDomain["Attributes"];
      const waitForReady = (domainIdValue: string, session: { note(message: string): Effect.Effect<void> }) =>
        Effect.gen(function* () {
          while (true) {
            const record = yield* clients.functions.getDomain(domainIdValue);
            const status = record.status?.toLowerCase();
            if (!status || status === "ready") return toAttributes(record);
            if (status === "error") throw new Error(record.error_message ?? `Scaleway function domain ${domainIdValue} entered error state`);
            yield* session.note(`waiting function domain ready status=${record.status ?? "unknown"}`);
            yield* Effect.sleep("3 seconds");
          }
        });
      const recoverExisting = (hostname: string, functionIdValue: string) =>
        Effect.gen(function* () {
          const domains = yield* clients.functions.listDomains(functionIdValue);
          const existing = domains.find((domain) => domain.hostname === hostname);
          if (!existing) return undefined;
          return existing.status?.toLowerCase() === "ready"
            ? toAttributes(existing)
            : yield* waitForReady(existing.id, { note: () => Effect.void });
        });

      return FunctionDomain.Provider.of({
        stables: ["domainId", "functionId", "hostname"],
        diff: Effect.fnUntraced(function* ({ news, output }) {
          if (!isResolved(news) || !output) return undefined;
          if ((yield* functionId(news.function)) !== output.functionId || news.hostname !== output.hostname) return { action: "replace" } as const;
          return { action: "noop" } as const;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.domainId) return undefined;
          return yield* clients.functions.getDomain(output.domainId).pipe(
            Effect.map(toAttributes),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ news, output, session }) {
          if (output?.domainId) return output;
          const resolvedFunctionId = yield* functionId(news.function);
          const created = clients.functions.createDomain({
            function_id: resolvedFunctionId,
            hostname: news.hostname,
          });
          return yield* created.pipe(
            Effect.flatMap((record) =>
              record.status?.toLowerCase() === "ready"
                ? Effect.succeed(toAttributes(record))
                : waitForReady(record.id, session)
            ),
            Effect.catchIf(isResourceAlreadyExists, () => recoverExisting(news.hostname, resolvedFunctionId)),
            Effect.flatMap((attributes) => attributes ? Effect.succeed(attributes) : Effect.fail(new Error(`Scaleway function domain ${news.hostname} already exists but could not be recovered`))),
          );
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.functions
            .deleteDomain(output.domainId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway function domain ${output.domainId}`);
        }),
      });
    }),
  );
