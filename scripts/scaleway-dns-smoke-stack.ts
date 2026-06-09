import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Scaleway from "../src/index.ts";

const prefix = process.env.SCW_DNS_SMOKE_PREFIX ?? "alchemy-dns-smoke";
const organizationId = process.env.SCW_ORGANIZATION_ID;
const dnsZone = process.env.SCW_DNS_SMOKE_ZONE ?? process.env.SCW_SMOKE_DNS_ZONE ?? "sip.finnvid.org";
const dnsDomain = process.env.SCW_DNS_SMOKE_DOMAIN ?? process.env.SCW_SMOKE_DNS_DOMAIN ?? dnsZone.split(".").slice(-2).join(".");
const dnsZoneSubdomain = dnsZone.endsWith(`.${dnsDomain}`) ? dnsZone.slice(0, -dnsDomain.length - 1) : undefined;
const recordName = process.env.SCW_DNS_SMOKE_RECORD ?? `_alchemy-${prefix}`;
const recordValue = process.env.SCW_DNS_SMOKE_VALUE ?? `alchemy-scaleway-dns-smoke=${prefix}`;

export default Alchemy.Stack(
  "alchemy-scaleway-dns-smoke",
  {
    providers: Scaleway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    if (!organizationId) throw new Error("SCW_ORGANIZATION_ID is required");

    const project = yield* Scaleway.Project("AppProject", {
      name: `${prefix}-project`,
      organizationId,
      description: "alchemy-scaleway DNS smoke test app project",
    });

    const zone = yield* Scaleway.DnsZone("SharedZone", {
      domain: dnsDomain,
      subdomain: dnsZoneSubdomain,
      project,
    });

    const record = yield* Scaleway.DnsRecord("SharedZoneRecord", {
      zone,
      name: recordName,
      type: "TXT",
      ttl: 60,
      records: [recordValue],
    });

    const sharedDnsAssertion = Output.map(
      Output.all(project.projectId, zone.projectId, zone.managed, record.projectId),
      ([appProjectId, zoneProjectId, zoneManaged, recordProjectId]) => {
        if (zoneProjectId === appProjectId) {
          throw new Error(`expected shared DNS zone project to differ from app project ${appProjectId}`);
        }
        if (zoneManaged !== false) {
          throw new Error(`expected existing DNS zone to be referenced with managed=false, got ${String(zoneManaged)}`);
        }
        if (recordProjectId !== zoneProjectId) {
          throw new Error(`expected DNS record project ${recordProjectId} to match zone project ${zoneProjectId}`);
        }
        return true;
      },
    );

    return {
      sharedDnsAssertion,
      appProjectId: project.projectId,
      dnsZone: zone.dnsZone,
      dnsZoneProjectId: zone.projectId,
      dnsZoneManaged: zone.managed,
      recordName: record.name,
      recordProjectId: record.projectId,
      recordType: record.type,
    };
  }),
);
