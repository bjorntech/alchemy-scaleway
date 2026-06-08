import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import {
  makeScalewayClients,
  type ScalewayDnsRecord,
  type ScalewayDnsRecordType,
} from "./Clients.ts";
import type { Bucket } from "./Bucket.ts";
import type { Container } from "./Container.ts";
import type { DnsZone } from "./DnsZone.ts";
import { dnsZoneName } from "./DnsZone.ts";
import type { FlexibleIp } from "./FlexibleIp.ts";
import type { Function as ScalewayFunction } from "./Function.ts";
import type { Instance } from "./Instance.ts";
import { isNotFound } from "./Errors.ts";
import { credentialsProjectId, omitUndefined, projectInput, resolveRef, storedProjectInput, type ProjectRef } from "./Internal.ts";
import type { Providers } from "./Providers.ts";
import type { RegistryNamespace } from "./RegistryNamespace.ts";

export type DnsRecordType = ScalewayDnsRecordType;

export type DnsZoneRef = string | DnsZone;

export type DnsRecordTarget = string | Container | ScalewayFunction | FlexibleIp | Instance | RegistryNamespace | Bucket;

export interface DnsRecordValue {
  data: string;
  priority?: number;
  comment?: string;
}

export interface DnsRecordProps {
  zone: DnsZoneRef;
  project?: ProjectRef;
  name: string;
  type?: DnsRecordType;
  ttl?: number;
  records?: Array<string | DnsRecordValue>;
  target?: DnsRecordTarget;
  priority?: number;
  comment?: string;
  overwriteExisting?: boolean;
}

export type DnsRecord = Resource<
  "Scaleway.DnsRecord",
  DnsRecordProps,
  {
    dnsZone: string;
    projectId?: string;
    name: string;
    type: DnsRecordType;
    ttl?: number;
    records: ScalewayDnsRecord[];
  },
  never,
  Providers
>;

export const DnsRecord = Resource<DnsRecord>("Scaleway.DnsRecord");

const recordName = (name: string) => (name === "@" ? "" : name);
const withoutScheme = (value: string) => value.replace(/^https?:\/\//, "").replace(/\/$/, "");
const hostnameOnly = (value: string) => withoutScheme(value).split("/")[0] ?? "";
const absoluteHostname = (value: string) => {
  const hostname = hostnameOnly(value);
  return hostname.endsWith(".") ? hostname : `${hostname}.`;
};
const isIpv6 = (value: string) => value.includes(":");
const isIpv4 = (value: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
const typeFor = (data: string): DnsRecordType => (isIpv4(data) ? "A" : isIpv6(data) ? "AAAA" : "CNAME");

const optionalRef = (ref: unknown): Effect.Effect<string | undefined> =>
  ref === undefined
    ? Effect.succeed(undefined)
    : typeof ref === "object" && ref !== null && "projectId" in ref
      ? resolveRef((ref as { projectId: unknown }).projectId).pipe(Effect.map((value) => value || undefined))
    : resolveRef(ref).pipe(Effect.map((value) => value || undefined));

const hasZone = (props: Partial<Pick<DnsRecordProps, "zone">>): props is Pick<DnsRecordProps, "zone"> =>
  props.zone !== undefined;

const zoneIdentity = (props: Pick<DnsRecordProps, "zone" | "project">, stored = false) =>
  Effect.gen(function* () {
    const zone = props.zone;
    const explicitProjectId = yield* optionalRef(stored ? storedProjectInput(props) : projectInput(props));
    if (typeof zone === "string") {
      return { dnsZone: zone, projectId: explicitProjectId ?? (yield* credentialsProjectId()) };
    }
    const zoneProjectId = yield* optionalRef(zone.projectId);
    return {
      dnsZone: yield* resolveRef(zone.dnsZone),
      projectId: zoneProjectId ?? explicitProjectId ?? (yield* credentialsProjectId()),
    };
  });

const resolveStringArray = (ref: unknown): Effect.Effect<string[] | undefined> =>
  Effect.gen(function* () {
    if (Array.isArray(ref)) return ref.filter((item): item is string => typeof item === "string");
    if (ref && typeof ref === "object" && "asEffect" in ref) {
      const accessor = yield* (ref as { asEffect(): Effect.Effect<Effect.Effect<string[]>> }).asEffect();
      return yield* accessor;
    }
    return undefined;
  });

const targetData = (target: DnsRecordTarget): Effect.Effect<string> =>
  Effect.gen(function* () {
    if (typeof target === "string") return hostnameOnly(target);
    if ("address" in target) return yield* resolveRef(target.address);
    if ("domainName" in target) return hostnameOnly(yield* resolveRef(target.domainName));
    if ("publicEndpoint" in target) return hostnameOnly(yield* resolveRef(target.publicEndpoint));
    if ("endpoint" in target) return hostnameOnly(yield* resolveRef(target.endpoint));
    if ("publicIpAddresses" in target) {
      const addresses = yield* resolveStringArray(target.publicIpAddresses);
      if (addresses?.[0]) return addresses[0];
      const dns = yield* resolveRef(target.dns);
      if (dns) return hostnameOnly(dns);
    }
    throw new Error("DNS target does not expose a usable address or hostname");
  });

const desiredRecords = (props: DnsRecordProps) =>
  Effect.gen(function* () {
    const values = props.records
      ? props.records.map((record) =>
          typeof record === "string" ? { data: record } : record,
        )
      : props.target
        ? [{ data: yield* targetData(props.target) }]
        : [];
    if (values.length === 0) throw new Error("DnsRecord requires records or target");
    const type = props.type ?? typeFor(values[0].data);
    return values.map((record) =>
      omitUndefined({
        name: recordName(props.name),
        type,
        data: type === "CNAME" ? absoluteHostname(record.data) : record.data,
        ttl: props.ttl ?? 300,
        priority: record.priority ?? props.priority ?? 0,
        comment: record.comment ?? props.comment,
      }) as ScalewayDnsRecord,
    );
  });

const desiredRecordsOption = (props: DnsRecordProps) =>
  props.records || props.target
    ? desiredRecords(props)
    : Effect.succeed(undefined);

const recordsEqual = (left: ScalewayDnsRecord[], right: ScalewayDnsRecord[]) => {
  const normalize = (records: ScalewayDnsRecord[]) =>
    records
      .map((record) => ({
        name: record.name,
        type: record.type,
        data: record.data,
        ttl: record.ttl ?? 300,
        priority: record.priority ?? 0,
        comment: record.comment ?? undefined,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
};

const failExistingRecord = (dnsZone: string, name: string, type: DnsRecordType) =>
  Effect.fail(new Error(`Scaleway DNS ${type} ${name || "@"} already exists in ${dnsZone}; set overwriteExisting: true to replace it`));

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const DnsRecordProvider = () =>
  Provider.effect(
    DnsRecord,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const readRecords = (dnsZone: string, name: string, type: DnsRecordType, projectId?: string) =>
        clients.dns.listRecords({ dnsZone, name: recordName(name), type, projectId }).pipe(
          Effect.catchIf(isNotFound, () => Effect.succeed([])),
        );

      return DnsRecord.Provider.of({
        stables: ["dnsZone", "projectId", "name", "type"],
        diff: Effect.fnUntraced(function* ({ news, output }) {
          if (!isResolved(news) || !output) return undefined;
          const zone = yield* zoneIdentity(news);
          const desired = yield* desiredRecords(news);
          if (
            output.dnsZone !== zone.dnsZone ||
            (output.projectId ?? zone.projectId) !== zone.projectId ||
            output.name !== recordName(news.name) ||
            output.type !== desired[0].type
          ) return { action: "replace" } as const;
          if (!recordsEqual(output.records, desired)) return { action: "update" } as const;
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ olds, output }) {
          const oldZone = olds && hasZone(olds) ? yield* zoneIdentity(olds, true) : undefined;
          const zone = output?.dnsZone
            ? { dnsZone: output.dnsZone, projectId: output.projectId ?? oldZone?.projectId }
            : oldZone;
          if (!zone) return undefined;
          const oldRecords = olds ? yield* desiredRecordsOption(olds) : undefined;
          const type = output?.type ?? oldRecords?.[0]?.type;
          if (!type) return undefined;
          const name = output?.name ?? (olds ? recordName(olds.name) : undefined);
          if (name === undefined) return undefined;
          const records = yield* readRecords(zone.dnsZone, name, type, zone.projectId);
          if (records.length === 0) return undefined;
          return {
            dnsZone: zone.dnsZone,
            projectId: zone.projectId,
            name,
            type,
            ttl: records[0].ttl,
            records,
          } satisfies DnsRecord["Attributes"];
        }),
        reconcile: Effect.fnUntraced(function* ({ news, output, session }) {
          const zone = yield* zoneIdentity(news);
          const records = yield* desiredRecords(news);
          const type = records[0].type;
          const name = recordName(news.name);
          const existing = output?.dnsZone ? [] : yield* readRecords(zone.dnsZone, name, type, zone.projectId);
          if (existing.length > 0 && !news.overwriteExisting) return yield* failExistingRecord(zone.dnsZone, name, type);
          const updated = yield* clients.dns.updateRecords({
            dnsZone: zone.dnsZone,
            projectId: zone.projectId,
            return_all_records: false,
            disallow_new_zone_creation: true,
            changes: [
              {
                set: {
                  id_fields: { name, type },
                  records,
                },
              },
            ],
          });
          const current = updated.length > 0 ? updated : records;
          yield* session.note(`Upserted Scaleway DNS ${type} ${recordName(news.name)} in ${zone.dnsZone}`);
          return {
            dnsZone: zone.dnsZone,
            projectId: zone.projectId,
            name,
            type,
            ttl: records[0].ttl,
            records: current,
          } satisfies DnsRecord["Attributes"];
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.dns.updateRecords({
            dnsZone: output.dnsZone,
            projectId: output.projectId ?? (yield* credentialsProjectId()),
            return_all_records: false,
            disallow_new_zone_creation: true,
            changes: [{ delete: { id_fields: { name: output.name, type: output.type } } }],
          }).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway DNS ${output.type} ${output.name} in ${output.dnsZone}`);
        }),
      });
    }),
  );
