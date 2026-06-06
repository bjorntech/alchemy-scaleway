import { Resolver } from "node:dns/promises";
import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { isResolved } from "alchemy/Diff";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayDomainRecord } from "./Clients.ts";
import { isNotFound, ScalewayError } from "./Errors.ts";
import { omitUndefined, resolveRef } from "./Internal.ts";
import type { Container } from "./Container.ts";
import type { Providers } from "./Providers.ts";

export type DomainContainerRef = string | Container;

export interface DomainProps {
  container: DomainContainerRef;
  hostname: string;
  waitForCname?: boolean;
}

export type Domain = Resource<
  "Scaleway.Domain",
  DomainProps,
  { domainId: string; containerId: string; hostname: string; url?: string },
  never,
  Providers
>;

export const Domain = Resource<Domain>("Scaleway.Domain");

const containerId = (container: DomainContainerRef) => {
  return resolveRef(typeof container === "string" ? container : container.containerId);
};

const containerEndpoint = (container: DomainContainerRef) => {
  return typeof container === "string" ? Effect.succeed(undefined) : resolveRef(container.publicEndpoint);
};

const withoutScheme = (value: string) => value.replace(/^https?:\/\//, "").replace(/\/$/, "");
const absoluteHostname = (value: string) => {
  const hostname = withoutScheme(value);
  return hostname.endsWith(".") ? hostname : `${hostname}.`;
};

const isTransientState = (error: unknown) =>
  String((error as { message?: unknown })?.message ?? "")
    .toLowerCase()
    .includes("transient state");

const isRetriableDomainDeployError = (error: unknown) =>
  String((error as { message?: unknown })?.message ?? "")
    .toLowerCase()
    .includes("internal error occurred while deploying the domain");

const retryTransient = <A>(effect: Effect.Effect<A, ScalewayError>, attempts = 60): Effect.Effect<A, ScalewayError> =>
  effect.pipe(
    Effect.catch((error) =>
      attempts > 1 && isTransientState(error)
        ? Effect.sleep("5 seconds").pipe(Effect.flatMap(() => retryTransient(effect, attempts - 1)))
        : Effect.fail(error),
    ),
  );

function lookupCnames(hostname: string) {
  return Effect.tryPromise(() => resolveCnames(hostname));
}

async function resolveCnames(hostname: string) {
  const results = await Promise.allSettled(
    ["1.1.1.1", "8.8.8.8", "ns0.dom.scw.cloud", "ns1.dom.scw.cloud"].map(async (server) => {
      const resolver = new Resolver();
      resolver.setServers([server]);
      return resolver.resolveCname(hostname);
    }),
  );
  return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
}

function hasCname(cnames: string[], expected: string) {
  return cnames.map((record) => absoluteHostname(record).toLowerCase()).includes(expected);
}

function pollCname(hostname: string, expected: string, attempts: number): Effect.Effect<void, Error> {
  return lookupCnames(hostname).pipe(
    Effect.catch(() => Effect.succeed([] as string[])),
    Effect.flatMap((cnames) => hasCname(cnames, expected) ? Effect.void : retryCname(hostname, expected, attempts)),
  );
}

function retryCname(hostname: string, expected: string, attempts: number): Effect.Effect<void, Error> {
  return attempts <= 1
    ? Effect.fail(new Error(`Timed out waiting for DNS ${hostname} to resolve to ${expected}`))
    : Effect.sleep("5 seconds").pipe(Effect.flatMap(() => pollCname(hostname, expected, attempts - 1)));
}

function waitForCname(hostname: string, target: string, attempts = 36) {
  return pollCname(hostname, absoluteHostname(target).toLowerCase(), attempts);
}

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const DomainProvider = () =>
  Provider.effect(
    Domain,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const toAttributes = (record: ScalewayDomainRecord): Domain["Attributes"] =>
        omitUndefined({
          domainId: record.id,
          containerId: record.container_id,
          hostname: record.hostname,
          // v1 no longer returns a `url`; the public URL is always https on the hostname.
          url: `https://${record.hostname}`,
        }) as Domain["Attributes"];
      const waitForReady = (
        domainIdValue: string,
        attempts = 40,
      ): Effect.Effect<Domain["Attributes"], unknown> =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < attempts; attempt++) {
            const record = yield* clients.containers.getDomain(domainIdValue);
            const status = record.status?.toLowerCase();
            if (!status || status === "ready") return toAttributes(record);
            if (status === "error")
              return yield* Effect.fail(new Error(
                record.error_message ?? `Scaleway domain ${domainIdValue} entered error state`,
              ));
            yield* Effect.sleep("3 seconds");
          }
          return yield* Effect.fail(new Error(`Timed out waiting for Scaleway domain ${domainIdValue}`));
        });

      return Domain.Provider.of({
        stables: ["domainId", "containerId", "hostname"],
        diff: Effect.fnUntraced(function* ({ news, output }) {
          if (!isResolved(news) || !output) return undefined;
          const resolvedContainerId = yield* containerId(news.container);
          if (resolvedContainerId !== output.containerId || news.hostname !== output.hostname)
            return { action: "replace" } as const;
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.domainId) return undefined;
          return yield* clients.containers.getDomain(output.domainId).pipe(
            Effect.map(toAttributes),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ news, output, session }) {
          if (output?.domainId) return output;
          const input = {
            container_id: yield* containerId(news.container),
            hostname: news.hostname,
          };
          const target = yield* containerEndpoint(news.container);
          if (news.waitForCname && target) {
            yield* session.note(`Waiting for DNS ${news.hostname} to point at ${withoutScheme(target)}`);
            yield* waitForCname(news.hostname, target);
          }
          const createReadyDomain = (attempts = 4): Effect.Effect<Domain["Attributes"], unknown> =>
            Effect.gen(function* () {
              const created = yield* retryTransient(clients.containers.createDomain(input));
              yield* session.note(`Created Scaleway domain ${created.id}`);
              return yield* waitForReady(created.id).pipe(
                Effect.catchIf(isRetriableDomainDeployError, (error) =>
                  attempts > 1
                    ? Effect.gen(function* () {
                      yield* session.note(`Retrying Scaleway domain ${created.id} after transient deployment error`);
                      yield* clients.containers.deleteDomain(created.id).pipe(Effect.catchIf(isNotFound, () => Effect.void));
                      yield* Effect.sleep("1 second");
                      return yield* createReadyDomain(attempts - 1);
                    })
                    : Effect.fail(error),
                ),
              );
            });
          const createDomain = createReadyDomain();
          return yield* createDomain.pipe(
            Effect.catchIf(isTransientState, () =>
              Effect.gen(function* () {
                if (target) {
                  yield* session.note(`Waiting for DNS ${news.hostname} to point at ${withoutScheme(target)}`);
                  yield* waitForCname(news.hostname, target);
                }
                return yield* createReadyDomain();
              }),
            ),
          );
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.containers
            .deleteDomain(output.domainId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway domain ${output.domainId}`);
        }),
      });
    }),
  );
