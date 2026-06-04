import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { isResolved } from "alchemy/Diff";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayDomainRecord } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { omitUndefined, resolveRef } from "./Internal.ts";
import type { Container } from "./Container.ts";
import type { Providers } from "./Providers.ts";

export type DomainContainerRef = string | Container;

export interface DomainProps {
  container: DomainContainerRef;
  hostname: string;
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

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const DomainProvider = () =>
  Provider.effect(
    Domain,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const toAttributes = (record: ScalewayDomainRecord): Domain["Attributes"] =>
        omitUndefined({ domainId: record.id, containerId: record.container_id, hostname: record.hostname, url: record.url }) as Domain["Attributes"];
      const waitForReady = (domainIdValue: string, attempts = 40): Effect.Effect<Domain["Attributes"], unknown> =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < attempts; attempt++) {
            const record = yield* clients.containers.getDomain(domainIdValue);
            const status = record.status?.toLowerCase();
            if (!status || status === "ready") return toAttributes(record);
            if (status === "error") throw new Error(record.error_message ?? `Scaleway domain ${domainIdValue} entered error state`);
            yield* Effect.sleep("3 seconds");
          }
          throw new Error(`Timed out waiting for Scaleway domain ${domainIdValue}`);
        });

      return Domain.Provider.of({
        stables: ["domainId", "containerId", "hostname"],
        diff: Effect.fnUntraced(function* ({ news, output }) {
          if (!isResolved(news) || !output) return undefined;
          const resolvedContainerId = yield* containerId(news.container);
          if (resolvedContainerId !== output.containerId || news.hostname !== output.hostname) return { action: "replace" } as const;
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
          const created = yield* clients.containers.createDomain({ container_id: yield* containerId(news.container), hostname: news.hostname });
          yield* session.note(`Created Scaleway domain ${created.id}`);
          return yield* waitForReady(created.id);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.containers.deleteDomain(output.domainId).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway domain ${output.domainId}`);
        }),
      });
    }),
  );
