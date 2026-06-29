import { Resolver } from "node:dns/promises";
import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { isResolved } from "alchemy/Diff";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayDomainRecord } from "./Clients.ts";
import { isNotFound, ScalewayError } from "./Errors.ts";
import { omitUndefined, parentReadiness, resolveRef } from "./Internal.ts";
import type { Container } from "./Container.ts";
import type { Providers } from "./Providers.ts";

export type DomainContainerRef = string | Container;

export interface DomainProps {
  container: DomainContainerRef;
  hostname: string;
  waitForCname?: boolean;
  /**
   * Scheduling-only anchor that forces a real Alchemy upstream edge to the
   * referenced container's reconcile. Defaulted from the container's non-stable
   * `status` output so a custom domain is never created while the container is
   * mid-update. Not used by the provider lifecycle.
   */
  containerReadiness?: unknown;
}

export type Domain = Resource<
  "Scaleway.Domain",
  DomainProps,
  { domainId: string; containerId: string; hostname: string; url?: string },
  never,
  Providers
>;

const DomainResource = Resource<Domain>("Scaleway.Domain");

export const Domain = Object.assign(
  (id: string, props: DomainProps) =>
    DomainResource(id, {
      ...props,
      containerReadiness: props.containerReadiness ?? parentReadiness(props.container),
    }),
  DomainResource,
) as typeof DomainResource;

const containerId = (container: DomainContainerRef) => {
  return resolveRef(typeof container === "string" ? container : container.containerId);
};

const containerEndpoint = (container: DomainContainerRef) => {
  if (typeof container === "string") return Effect.succeed(undefined);
  return container.publicEndpoint === undefined
    ? Effect.succeed(undefined)
    : resolveRef(container.publicEndpoint);
};

export const withoutScheme = (value: string) =>
  value.replace(/^https?:\/\//, "").replace(/\/$/, "");
export const absoluteHostname = (value: string) => {
  const hostname = withoutScheme(value);
  return hostname.endsWith(".") ? hostname : `${hostname}.`;
};
export const publicDnsResolvers = ["1.1.1.1", "8.8.8.8"] as const;
const maxDomainDeployRetries = 10;

const isTransientState = (error: unknown) =>
  String((error as { message?: unknown })?.message ?? "")
    .toLowerCase()
    .includes("transient state");

const isRetriableDomainDeployError = (error: unknown) =>
  String((error as { message?: unknown })?.message ?? error ?? "")
    .toLowerCase()
    .includes("internal error occurred while deploying the domain");

const isResourceAlreadyExists = (error: unknown) =>
  error instanceof ScalewayError &&
  error.statusCode === 409 &&
  error.message.toLowerCase().includes("resource already exists");

const retryTransient = <A>(
  effect: Effect.Effect<A, ScalewayError>,
  session: { note(message: string): Effect.Effect<void> },
): Effect.Effect<A, ScalewayError> =>
  effect.pipe(
    Effect.catch((error) =>
      isTransientState(error)
        ? session.note("waiting domain operation status=transient").pipe(
            Effect.flatMap(() => Effect.sleep("5 seconds")),
            Effect.flatMap(() => retryTransient(effect, session)),
          )
        : Effect.fail(error),
    ),
  );

export interface CnameLookupResult {
  server: string;
  cnames: string[];
}

/**
 * Resolver seam. The default implementation queries each public recursive
 * resolver independently; tests substitute a deterministic fake so the
 * public-DNS readiness semantics can be verified without real network I/O.
 */
export type CnameResolver = (
  hostname: string,
  servers: readonly string[],
) => Promise<CnameLookupResult[]>;

async function resolveCnames(
  hostname: string,
  servers: readonly string[],
): Promise<CnameLookupResult[]> {
  const results = await Promise.all(
    servers.map(async (server) => {
      const resolver = new Resolver();
      resolver.setServers([server]);
      try {
        return { server, cnames: await resolver.resolveCname(hostname) };
      } catch {
        return { server, cnames: [] };
      }
    }),
  );
  return results;
}

let cnameResolver: CnameResolver = resolveCnames;

export const setCnameResolver = (next: CnameResolver) => {
  cnameResolver = next;
};

export const resetCnameResolver = () => {
  cnameResolver = resolveCnames;
};

function lookupCnames(hostname: string) {
  return Effect.tryPromise(() => cnameResolver(hostname, publicDnsResolvers));
}

export function hasCname(cnames: string[], expected: string) {
  return cnames.map((record) => absoluteHostname(record).toLowerCase()).includes(expected);
}

export function cnameMatches(hostname: string, expected: string) {
  return lookupCnames(hostname).pipe(
    Effect.catch(() => Effect.succeed([] as CnameLookupResult[])),
    Effect.map(
      (lookups) =>
        lookups.length > 0 && lookups.every((lookup) => hasCname(lookup.cnames, expected)),
    ),
  );
}

function retryCname(
  hostname: string,
  expected: string,
  session: { note(message: string): Effect.Effect<void> },
): Effect.Effect<void, Error> {
  return session.note(`waiting DNS CNAME hostname=${hostname} target=${expected}`).pipe(
    Effect.flatMap(() => Effect.sleep("5 seconds")),
    Effect.flatMap(() => waitForCnameMatch(hostname, expected, session)),
  );
}

function waitForCnameMatch(
  hostname: string,
  expected: string,
  session: { note(message: string): Effect.Effect<void> },
): Effect.Effect<void, Error> {
  return cnameMatches(hostname, expected).pipe(
    Effect.flatMap((matches) => (matches ? Effect.void : retryCname(hostname, expected, session))),
  );
}

export function waitForCname(
  hostname: string,
  target: string,
  session: { note(message: string): Effect.Effect<void> },
) {
  const expected = absoluteHostname(target).toLowerCase();
  return waitForCnameMatch(hostname, expected, session);
}

function waitForPublicCnameIfAvailable(
  hostname: string,
  target: string | undefined,
  session: { note(message: string): Effect.Effect<void> },
) {
  if (!target) return Effect.void;
  return session
    .note(`Waiting for public DNS ${hostname} to point at ${withoutScheme(target)}`)
    .pipe(Effect.flatMap(() => waitForCname(hostname, target, session)));
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
        session: { note(message: string): Effect.Effect<void> },
      ): Effect.Effect<Domain["Attributes"], unknown> =>
        Effect.gen(function* () {
          while (true) {
            const record = yield* clients.containers.getDomain(domainIdValue);
            const status = record.status?.toLowerCase();
            if (!status || status === "ready") return toAttributes(record);
            if (status === "error")
              return yield* Effect.fail(
                new Error(
                  record.error_message ?? `Scaleway domain ${domainIdValue} entered error state`,
                ),
              );
            yield* session.note(`waiting domain ready status=${record.status ?? "unknown"}`);
            yield* Effect.sleep("3 seconds");
          }
        });
      const waitForDeleted = (
        domainIdValue: string,
        session: { note(message: string): Effect.Effect<void> },
      ) =>
        Effect.gen(function* () {
          while (true) {
            const existing = yield* clients.containers
              .getDomain(domainIdValue)
              .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
            if (!existing) return;
            yield* session.note(`waiting domain deletion status=${existing.status ?? "unknown"}`);
            yield* Effect.sleep("3 seconds");
          }
        });
      const domainsForHostname = (hostname: string) =>
        clients.containers.listDomains().pipe(
          Effect.map((domains) => domains.filter((domain) => domain.hostname === hostname)),
          Effect.catchIf(isNotFound, () => Effect.succeed([] as ScalewayDomainRecord[])),
        );

      return Domain.Provider.of({
        stables: ["domainId", "containerId", "hostname"],
        list: () => Effect.succeed([]),
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
          const resolvedContainerId = yield* containerId(news.container);
          const input = {
            container_id: resolvedContainerId,
            hostname: news.hostname,
          };
          const target = yield* containerEndpoint(news.container);
          const createReadyDomain = (
            retriesRemaining = maxDomainDeployRetries,
          ): Effect.Effect<Domain["Attributes"], unknown> =>
            Effect.gen(function* () {
              if (news.waitForCname)
                yield* waitForPublicCnameIfAvailable(news.hostname, target, session);
              const created = yield* retryTransient(
                clients.containers.createDomain(input),
                session,
              );
              yield* session.note(`Created Scaleway domain ${created.id}`);
              return yield* waitForReady(created.id, session).pipe(
                Effect.catchIf(isRetriableDomainDeployError, () =>
                  Effect.gen(function* () {
                    if (retriesRemaining <= 0) {
                      return yield* Effect.fail(
                        new Error(
                          `Scaleway domain ${created.id} kept failing deployment after retries`,
                        ),
                      );
                    }
                    yield* session.note(
                      `Retrying Scaleway domain ${created.id} after transient deployment error`,
                    );
                    yield* clients.containers
                      .deleteDomain(created.id)
                      .pipe(Effect.catchIf(isNotFound, () => Effect.void));
                    yield* waitForDeleted(created.id, session);
                    if (news.waitForCname)
                      yield* waitForPublicCnameIfAvailable(news.hostname, target, session);
                    return yield* createReadyDomain(retriesRemaining - 1);
                  }),
                ),
              );
            });
          const recoverExistingDomain = (
            retriesRemaining = maxDomainDeployRetries,
          ): Effect.Effect<Domain["Attributes"], unknown> =>
            Effect.gen(function* () {
              const existingDomains = yield* domainsForHostname(news.hostname);
              const conflict = existingDomains.find(
                (domain) => domain.container_id !== resolvedContainerId,
              );
              if (conflict) {
                return yield* Effect.fail(
                  new Error(
                    `Scaleway domain ${news.hostname} already exists for container ${conflict.container_id}`,
                  ),
                );
              }
              const existing = existingDomains.find(
                (domain) => domain.container_id === resolvedContainerId,
              );
              if (!existing) return yield* createReadyDomain(retriesRemaining);
              const status = existing.status?.toLowerCase();
              if (!status || status === "ready") return toAttributes(existing);
              if (status === "error" && isRetriableDomainDeployError(existing.error_message)) {
                if (retriesRemaining <= 0)
                  return yield* Effect.fail(
                    new Error(
                      `Scaleway domain ${existing.id} kept failing deployment after retries`,
                    ),
                  );
                yield* session.note(
                  `Retrying Scaleway domain ${existing.id} after transient deployment error`,
                );
                yield* clients.containers
                  .deleteDomain(existing.id)
                  .pipe(Effect.catchIf(isNotFound, () => Effect.void));
                yield* waitForDeleted(existing.id, session);
                if (news.waitForCname)
                  yield* waitForPublicCnameIfAvailable(news.hostname, target, session);
                return yield* createReadyDomain(retriesRemaining - 1);
              }
              return yield* waitForReady(existing.id, session);
            });
          const createDomain = createReadyDomain();
          return yield* createDomain.pipe(
            Effect.catchIf(isResourceAlreadyExists, () => recoverExistingDomain()),
            Effect.catchIf(isTransientState, () =>
              Effect.gen(function* () {
                if (news.waitForCname)
                  yield* waitForPublicCnameIfAvailable(news.hostname, target, session);
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
