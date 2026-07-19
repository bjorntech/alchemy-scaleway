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
    managed?: boolean;
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
const isDnsZoneMissing = (error: unknown) => isNotFound(error) || String((error as { message?: unknown })?.message ?? "").toLowerCase().includes("domain not found");
const isZoneAlreadyExists = (error: unknown) => String((error as { message?: unknown })?.message ?? "").toLowerCase().includes("zone already exists");

const exactZones = (zones: ScalewayDnsZoneRecord[], dnsZone: string) =>
  zones.filter((zone) => dnsZoneName(zone.domain, subdomainOf(zone)) === dnsZone);

const singleZoneOrAmbiguous = (zones: ScalewayDnsZoneRecord[], dnsZone: string) => {
  if (zones.length <= 1) return Effect.succeed(zones[0]);
  const projects = zones.map((zone) => zone.project_id ?? "unknown").join(", ");
  return Effect.fail(new Error(`Scaleway DNS zone ${dnsZone} is visible in multiple projects (${projects}); pass the DNS authority project explicitly`));
};

const toAttributes = (zone: ScalewayDnsZoneRecord, managed?: boolean): DnsZone["Attributes"] =>
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
    managed,
  }) as DnsZone["Attributes"];

function managedIfSameProject(zone: ScalewayDnsZoneRecord, managed: boolean | undefined, projectId: string | undefined) {
  if (managed !== true) return false;
  return zone.project_id === projectId;
}

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const DnsZoneProvider = () =>
  Provider.effect(
    DnsZone,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const findZoneInProject = (dnsZone: string, explicitProjectId?: string) =>
        clients.dns.listZones({ dnsZone, projectId: explicitProjectId }).pipe(
          Effect.map((zones) => exactZones(zones, dnsZone)[0]),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );
      const findUnambiguousZone = (dnsZone: string) =>
        clients.dns.listZones({ dnsZone }).pipe(
          Effect.map((zones) => exactZones(zones, dnsZone)),
          Effect.flatMap((zones) => singleZoneOrAmbiguous(zones, dnsZone)),
          Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
        );
      const findZone = (dnsZone: string, preferredProjectId?: string) =>
        Effect.gen(function* () {
          const preferred = preferredProjectId ? yield* findZoneInProject(dnsZone, preferredProjectId) : undefined;
          return preferred ?? (yield* findUnambiguousZone(dnsZone));
        });

      return DnsZone.Provider.of({
        stables: ["dnsZone", "domain", "subdomain", "projectId"],
        list: () => Effect.succeed([]),
        diff: Effect.fnUntraced(function* ({ news, output }) {
          if (!isResolved(news) || !output) return undefined;
          const desiredName = dnsZoneName(news.domain, news.subdomain);
          if (output.dnsZone !== desiredName) return { action: "replace" } as const;
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ olds, output }) {
          const dnsZone = output?.dnsZone ?? (olds ? dnsZoneName(olds.domain, olds.subdomain) : undefined);
          if (!dnsZone) return undefined;
          const oldProjectId = olds ? yield* credentialsProjectId(storedProjectInput(olds)) : undefined;
          const found = yield* findZone(dnsZone, output?.projectId ?? oldProjectId);
          if (!found) return undefined;
          return toAttributes(found, managedIfSameProject(found, output?.managed, output?.projectId ?? oldProjectId));
        }),
        reconcile: Effect.fnUntraced(function* ({ news, output, session }) {
          const dnsZone = dnsZoneName(news.domain, news.subdomain);
          const desiredProjectId = yield* credentialsProjectId(projectInput(news));
          const existing = output?.dnsZone ? yield* findZone(output.dnsZone, output.projectId ?? desiredProjectId) : yield* findZone(dnsZone, desiredProjectId);
          if (existing) {
            yield* session.note(`Using Scaleway DNS zone ${dnsZone}`);
            return toAttributes(existing, managedIfSameProject(existing, output?.managed, output?.projectId ?? desiredProjectId));
          }
          if (!news.subdomain) return yield* Effect.fail(missingApexZoneError(dnsZone));
          const created = yield* clients.dns.createZone({
            domain: news.domain,
            subdomain: news.subdomain,
            project_id: desiredProjectId,
          }).pipe(
            Effect.catchIf(isZoneAlreadyExists, () =>
              Effect.gen(function* () {
                const recovered = yield* findZone(dnsZone, desiredProjectId);
                return recovered ?? (yield* Effect.fail(new Error(`Scaleway DNS zone ${dnsZone} already exists but could not be recovered`)));
              })
            ),
          );
          const createdManaged = created.project_id === desiredProjectId;
          yield* session.note(`${createdManaged ? "Created" : "Using"} Scaleway DNS zone ${dnsZone}`);
          return toAttributes(created, createdManaged);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          if (output.managed !== true) {
            yield* session.note(`Retained referenced Scaleway DNS zone ${output.dnsZone}`);
            return;
          }
          if (!output.dnsZone || !output.projectId) return;
          yield* clients.dns.deleteZone({ dnsZone: output.dnsZone, projectId: output.projectId }).pipe(
            Effect.catchIf(isDnsZoneMissing, () => Effect.void),
          );
          yield* session.note(`Deleted Scaleway DNS zone ${output.dnsZone}`);
        }),
      });
    }),
  );
