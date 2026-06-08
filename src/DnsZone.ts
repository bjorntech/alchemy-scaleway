import { Unowned } from "alchemy/AdoptPolicy";
import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayDnsZoneRecord } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { credentialsProjectId, omitUndefined, projectInput, storedProjectInput, type ProjectRef } from "./Internal.ts";
import type { Providers } from "./Providers.ts";

export interface DnsZoneProps {
  domain: string;
  subdomain?: string;
  project?: ProjectRef;
}

export type DnsZone = Resource<
  "Scaleway.DnsZone",
  DnsZoneProps,
  {
    dnsZone: string;
    domain: string;
    subdomain?: string;
    projectId?: string;
    nameServers?: string[];
    defaultNameServers?: string[];
    masterNameServers?: string[];
    status?: string;
    message?: string;
    updatedAt?: string;
    linkedProducts?: string[];
  },
  never,
  Providers
>;

export const DnsZone = Resource<DnsZone>("Scaleway.DnsZone", {
  defaultRemovalPolicy: "retain",
});

export const dnsZoneName = (domain: string, subdomain?: string) =>
  subdomain && subdomain.length > 0 ? `${subdomain}.${domain}` : domain;

const subdomainOf = (zone: ScalewayDnsZoneRecord) =>
  zone.subdomain && zone.subdomain.length > 0 ? zone.subdomain : undefined;

const missingApexZoneError = (dnsZone: string) =>
  new Error(
    `Scaleway DNS apex zone ${dnsZone} does not exist in this project. Register, transfer, or validate the domain in Scaleway first, then use DnsZone as an existing-zone reference; pass subdomain to create a child DNS zone.`,
  );

const toAttributes = (zone: ScalewayDnsZoneRecord): DnsZone["Attributes"] =>
  omitUndefined({
    dnsZone: dnsZoneName(zone.domain, subdomainOf(zone)),
    domain: zone.domain,
    subdomain: subdomainOf(zone),
    projectId: zone.project_id,
    nameServers: zone.ns,
    defaultNameServers: zone.ns_default,
    masterNameServers: zone.ns_master,
    status: zone.status,
    message: zone.message ?? undefined,
    updatedAt: zone.updated_at ?? undefined,
    linkedProducts: zone.linked_products,
  }) as DnsZone["Attributes"];

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const DnsZoneProvider = () =>
  Provider.effect(
    DnsZone,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const findZone = (dnsZone: string, explicitProjectId?: string) =>
        clients.dns.listZones({ dnsZone, projectId: explicitProjectId }).pipe(
          Effect.map((zones) =>
            zones.find((zone) => dnsZoneName(zone.domain, subdomainOf(zone)) === dnsZone),
          ),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );

      return DnsZone.Provider.of({
        stables: ["dnsZone", "domain", "subdomain", "projectId"],
        diff: Effect.fnUntraced(function* ({ news, output }) {
          if (!isResolved(news) || !output) return undefined;
          const desiredName = dnsZoneName(news.domain, news.subdomain);
          if (output.dnsZone !== desiredName) return { action: "replace" } as const;
          if (output.projectId !== (yield* credentialsProjectId(projectInput(news)))) return { action: "replace" } as const;
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ olds, output }) {
          const dnsZone = output?.dnsZone ?? (olds ? dnsZoneName(olds.domain, olds.subdomain) : undefined);
          if (!dnsZone) return undefined;
          const oldProjectId = olds ? yield* credentialsProjectId(storedProjectInput(olds)) : undefined;
          const found = yield* findZone(dnsZone, output?.projectId ?? oldProjectId);
          if (!found) return undefined;
          return output?.dnsZone ? toAttributes(found) : Unowned(toAttributes(found));
        }),
        reconcile: Effect.fnUntraced(function* ({ news, output, session }) {
          const dnsZone = dnsZoneName(news.domain, news.subdomain);
          const desiredProjectId = yield* credentialsProjectId(projectInput(news));
          const existing = output?.dnsZone ? yield* findZone(output.dnsZone, desiredProjectId) : yield* findZone(dnsZone, desiredProjectId);
          if (existing) {
            yield* session.note(`Using Scaleway DNS zone ${dnsZone}`);
            return toAttributes(existing);
          }
          if (!news.subdomain) return yield* Effect.fail(missingApexZoneError(dnsZone));
          const created = yield* clients.dns.createZone({
            domain: news.domain,
            subdomain: news.subdomain,
            project_id: desiredProjectId,
          });
          yield* session.note(`Created Scaleway DNS zone ${dnsZone}`);
          return toAttributes(created);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          if (!output.dnsZone || !output.projectId) return;
          yield* clients.dns.deleteZone({ dnsZone: output.dnsZone, projectId: output.projectId }).pipe(
            Effect.catchIf(isNotFound, () => Effect.void),
          );
          yield* session.note(`Deleted Scaleway DNS zone ${output.dnsZone}`);
        }),
      });
    }),
  );
