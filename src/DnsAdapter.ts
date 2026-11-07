import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Provider from "alchemy/Provider";
import { type ResourceBinding, type ResourceLike } from "alchemy/Resource";
import {
  adapterLayer,
  addressRecords,
  DnsAdapterError,
  isHostnameTarget,
  normalizeDnsName,
  type DnsAdapter,
  type DnsAliasSet,
  type DnsAliasTarget,
  type DnsConfig,
  type DnsRecord as AdapterRecord,
  type DnsHostnameTarget,
} from "alchemy/DNS/Adapter";
import * as Effect from "effect/Effect";
import {
  makeScalewayClients,
  type ScalewayDnsRecord,
  type ScalewayDnsZoneRecord,
} from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { projectInput, resolveRef, storedProjectInput, type ProjectRef } from "./Internal.ts";
import type { Providers } from "./Providers.ts";

export interface ScalewayDnsAdapterOptions {
  readonly zone?: Input<string>;
  readonly project?: Input<string>;
}

export const ScalewayDnsAdapter = (
  options: ScalewayDnsAdapterOptions = {},
): DnsConfig<"Scaleway.DNS"> => ({
  type: "Scaleway.DNS",
  ...(options.zone === undefined ? {} : { zone: options.zone }),
  options: {
    ...(options.zone === undefined ? {} : { zone: options.zone }),
    ...(options.project === undefined ? {} : { project: options.project }),
  },
});

export const Scaleway = { DNS: { Adapter: ScalewayDnsAdapter } } as const;
export const DNS = Scaleway.DNS;

export interface DnsRecordListProps {
  readonly zone?: Input<string>;
  readonly project?: Input<string> | ProjectRef;
  readonly records?: Input<AdapterRecord[]>;
  readonly target?: DnsAliasTarget;
  readonly names?: string[];
  readonly retain?: boolean;
}

type GroupType = AdapterRecord["type"];
type Ownership = "created" | "taken-over";

export interface DnsRecordGroup {
  readonly dnsZone: string;
  readonly projectId: string;
  readonly name: string;
  readonly type: GroupType;
  readonly records: ScalewayDnsRecord[];
  readonly ownership: Ownership;
  readonly retain: boolean;
}

export type DnsRecordListAttributes = {
  readonly dnsZone?: string;
  readonly projectId?: string;
  readonly name?: string;
  readonly type?: GroupType;
  readonly groups: DnsRecordGroup[];
  readonly records: ScalewayDnsRecord[];
  readonly names: string[];
};

type DnsRecordListBinding = { readonly names?: string[] };
export type DnsRecordListResource = ResourceLike<
  "Scaleway.DnsRecordList",
  DnsRecordListProps,
  DnsRecordListAttributes,
  DnsRecordListBinding,
  Providers
> &
  Pick<
    Resource<
      "Scaleway.DnsRecordList",
      DnsRecordListProps,
      DnsRecordListAttributes,
      DnsRecordListBinding,
      Providers
    >,
    "bind"
  >;

export const DnsRecordList = Resource<DnsRecordListResource>("Scaleway.DnsRecordList");

const resolveInput = <A>(value: Input<A>): Effect.Effect<A, unknown> =>
  Output.isOutput(value)
    ? Effect.gen(function* () {
        const output = value as Output.Output<A, never>;
        const effect = yield* output.asEffect();
        return yield* effect;
      })
    : Effect.succeed(value as A);

const normalize = normalizeDnsName;
const zoneName = (zone: ScalewayDnsZoneRecord) =>
  normalize(zone.subdomain ? `${zone.subdomain}.${zone.domain}` : zone.domain);
const isWithin = (hostname: string, zone: string) =>
  hostname === zone || hostname.endsWith(`.${zone}`);

/** Explicit zones interpret names not ending in the zone as relative names. */
const relativeDnsName = (value: string, zone: string) =>
  value === "@" ? zone : `${value}.${zone}`;

const fqdnFor = (name: string, zone?: string) => {
  const value = normalize(name);
  if (zone === undefined) return value;
  if (value === "@") return zone;
  if (value === zone || isWithin(value, zone)) return value;
  if (name.endsWith("."))
    throw new DnsAdapterError({ message: `DNS name ${name} is outside zone ${zone}` });
  return relativeDnsName(value, zone);
};

const relativeFor = (hostname: string, zone: string) => {
  const value = normalize(hostname);
  if (value === "@" || value === zone) return "";
  if (!isWithin(value, zone))
    throw new DnsAdapterError({ message: `DNS name ${hostname} is outside zone ${zone}` });
  return value.slice(0, -(zone.length + 1));
};

const valueForWire = (record: AdapterRecord) =>
  record.type === "CNAME" ? normalize(record.value) : record.value;

const resolveProject = (
  props: DnsRecordListProps,
  stored = false,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const value = stored ? storedProjectInput(props) : projectInput(props);
    return value === undefined ? undefined : yield* resolveRef(value);
  });

const namesFromBindings = (
  props: DnsRecordListProps,
  bindings: ReadonlyArray<ResourceBinding<DnsRecordListBinding> | DnsRecordListBinding>,
) => [
  ...new Set([
    ...(props.names ?? []),
    ...bindings.flatMap((binding) =>
      "data" in binding ? (binding.data?.names ?? []) : (binding.names ?? []),
    ),
  ]),
];

const targetRecords = (
  name: string,
  target: DnsAliasTarget,
): Effect.Effect<AdapterRecord[], unknown> =>
  Effect.gen(function* () {
    if ("route53Alias" in target && target.route53Alias !== undefined)
      return yield* Effect.fail(
        new DnsAdapterError({ message: "Scaleway DNS does not support Route 53 alias targets" }),
      );
    if (isHostnameTarget(target)) {
      return [{ name, type: "CNAME", value: yield* resolveInput(target.hostname) }];
    }
    const ipv4 = target.ipv4 === undefined ? [] : yield* resolveInput(target.ipv4);
    const ipv6 = target.ipv6 === undefined ? [] : yield* resolveInput(target.ipv6);
    return addressRecords(name, ipv4, ipv6) as AdapterRecord[];
  });

const resolveDesired = (
  props: DnsRecordListProps,
  names: string[],
): Effect.Effect<AdapterRecord[], unknown> =>
  Effect.gen(function* () {
    if (props.records !== undefined) return yield* resolveInput(props.records);
    if (props.target === undefined) {
      if (names.length === 0) return [];
      return yield* Effect.fail(
        new DnsAdapterError({ message: "DNS records require records or target" }),
      );
    }
    const target = props.target;
    const targetNames = names;
    const result: AdapterRecord[] = [];
    for (const name of targetNames) result.push(...(yield* targetRecords(name, target)));
    return result;
  });

const sameRecord = (left: ScalewayDnsRecord, right: ScalewayDnsRecord) =>
  (left.type === "CNAME" ? normalize(left.data) : left.data) ===
    (right.type === "CNAME" ? normalize(right.data) : right.data) &&
  (left.ttl ?? 300) === (right.ttl ?? 300) &&
  (left.priority ?? 0) === (right.priority ?? 0);

const sameSet = (live: ScalewayDnsRecord[], wanted: ScalewayDnsRecord[]) =>
  live.length === wanted.length &&
  wanted.every((record) => live.some((item) => sameRecord(item, record)));

const groupKey = (projectId: string, dnsZone: string, name: string, type: GroupType) =>
  `${projectId}\0${dnsZone}\0${name}\0${type}`;

const chooseZone = (zones: ScalewayDnsZoneRecord[], hostname: string, explicit?: string) => {
  const matches = zones.filter((zone) => {
    const name = zoneName(zone);
    return explicit ? name === explicit : isWithin(hostname, name);
  });
  if (matches.length === 0) return undefined;
  const mostSpecific = explicit
    ? matches
    : matches.filter(
        (zone) =>
          zoneName(zone).length === Math.max(...matches.map((item) => zoneName(item).length)),
      );
  const projects = new Set(mostSpecific.map((zone) => zone.project_id));
  if (mostSpecific.length !== 1 || projects.size !== 1)
    throw new DnsAdapterError({
      message: `DNS zone for ${hostname} is ambiguous; pass project explicitly`,
    });
  return mostSpecific[0];
};

const desiredGroups = (
  records: AdapterRecord[],
  zones: ScalewayDnsZoneRecord[],
  explicitZone: string | undefined,
  projectId: string | undefined,
  previous: readonly DnsRecordGroup[] = [],
) => {
  const groups = new Map<
    string,
    {
      dnsZone: string;
      projectId: string;
      name: string;
      type: GroupType;
      records: ScalewayDnsRecord[];
    }
  >();
  for (const record of records) {
    const hostname = fqdnFor(record.name, explicitZone);
    const previousAuthority = previous
      .filter((group) => isWithin(hostname, group.dnsZone))
      .sort((left, right) => right.dnsZone.length - left.dnsZone.length)[0];
    const candidateZones = previousAuthority
      ? zones.filter(
          (zone) =>
            zoneName(zone) === previousAuthority.dnsZone &&
            zone.project_id === previousAuthority.projectId,
        )
      : zones;
    const zone = chooseZone(candidateZones, hostname, explicitZone);
    if (!zone?.project_id)
      throw new DnsAdapterError({ message: `Could not resolve Scaleway DNS zone for ${hostname}` });
    const authority = zone.project_id;
    if (projectId !== undefined && authority !== projectId)
      throw new DnsAdapterError({
        message: `Scaleway DNS zone ${zoneName(zone)} is not in project ${projectId}`,
      });
    const dnsZone = zoneName(zone);
    const name = relativeFor(hostname, dnsZone);
    if (record.type === "CNAME" && name === "")
      throw new DnsAdapterError({
        message: "Scaleway DNS does not support CNAME records at the zone apex",
      });
    const wire: ScalewayDnsRecord = {
      name,
      type: record.type,
      data: valueForWire(record),
      ttl: record.ttl ?? 300,
    };
    const key = groupKey(authority, dnsZone, name, record.type);
    const existing = groups.get(key);
    if (existing) {
      if (!existing.records.some((item) => sameRecord(item, wire))) existing.records.push(wire);
    } else
      groups.set(key, { dnsZone, projectId: authority, name, type: record.type, records: [wire] });
  }
  return [...groups.values()];
};

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const DnsRecordListProvider = () =>
  Provider.effect(
    DnsRecordList,
    Effect.gen(function* () {
      const clients = yield* yield* makeScalewayClients;
      const readGroup = (group: Pick<DnsRecordGroup, "dnsZone" | "projectId" | "name" | "type">) =>
        clients.dns
          .listRecords({
            dnsZone: group.dnsZone,
            name: group.name,
            type: group.type,
            projectId: group.projectId,
          })
          .pipe(Effect.catchIf(isNotFound, () => Effect.succeed([])));
      const writeGroup = (group: {
        dnsZone: string;
        projectId: string;
        name: string;
        type: GroupType;
        records: ScalewayDnsRecord[];
      }) =>
        clients.dns.updateRecords({
          dnsZone: group.dnsZone,
          projectId: group.projectId,
          disallow_new_zone_creation: true,
          return_all_records: true,
          changes: [
            { set: { id_fields: { name: group.name, type: group.type }, records: group.records } },
          ],
        });
      const deleteGroup = (
        group: Pick<DnsRecordGroup, "dnsZone" | "projectId" | "name" | "type">,
      ) =>
        clients.dns
          .updateRecords({
            dnsZone: group.dnsZone,
            projectId: group.projectId,
            disallow_new_zone_creation: true,
            changes: [{ delete: { id_fields: { name: group.name, type: group.type } } }],
          })
          .pipe(Effect.catchIf(isNotFound, () => Effect.void));

      return DnsRecordList.Provider.of({
        stables: [],
        list: () => Effect.succeed([]),
        diff: Effect.fnUntraced(function* ({ news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          const project = yield* resolveProject(news);
          if (project !== undefined && output.groups.some((group) => group.projectId !== project))
            return yield* Effect.fail(
              new DnsAdapterError({ message: "Refusing to move DNS authority project" }),
            );
          return { action: "update" } as const;
        }),
        read: Effect.fnUntraced(function* ({ olds, output }) {
          if (output === undefined) return undefined;
          const present: DnsRecordGroup[] = [];
          for (const group of output.groups) {
            const records = yield* readGroup(group);
            if (records.length > 0) present.push({ ...group, records });
          }
          return present.length === 0
            ? undefined
            : { ...output, groups: present, records: present.flatMap((group) => group.records) };
        }),
        reconcile: Effect.fnUntraced(function* ({ news, output, bindings, session }) {
          const project = yield* resolveProject(news);
          if (
            output !== undefined &&
            project !== undefined &&
            output.groups.some((group) => group.projectId !== project)
          )
            return yield* Effect.fail(
              new DnsAdapterError({ message: "Refusing to move DNS authority project" }),
            );
          const names = namesFromBindings(news, bindings);
          const records = yield* resolveDesired(news, names);
          const explicitZone =
            news.zone === undefined ? undefined : normalize(yield* resolveInput(news.zone));
          const zones = yield* clients.dns.listZones({ projectId: project });
          const previous = output?.groups ?? [];
          const wanted = desiredGroups(records, zones, explicitZone, project, previous);
          const wantedKeys = new Set(
            wanted.map((group) => groupKey(group.projectId, group.dnsZone, group.name, group.type)),
          );
          const persisted: DnsRecordGroup[] = [];
          for (const group of wanted) {
            const old = previous.find(
              (item) =>
                groupKey(item.projectId, item.dnsZone, item.name, item.type) ===
                groupKey(group.projectId, group.dnsZone, group.name, group.type),
            );
            const live = yield* readGroup(group);
            // The DNS API has no ownership marker.  A matching live value is
            // not evidence that this resource wrote it: it may be a foreign
            // record or a group left by an interrupted write whose state was
            // never persisted.  Only a persisted group ownership value makes
            // it safe to reconcile or delete an existing set.
            if (old === undefined && live.length > 0)
              return yield* Effect.fail(
                new DnsAdapterError({
                  message: `Refusing unowned Scaleway DNS ${group.type} ${group.name || "@"}`,
                }),
              );
            const ownership: Ownership = old?.ownership ?? "created";
            const current = sameSet(live, group.records)
              ? live
              : (yield* writeGroup(group), yield* readGroup(group));
            persisted.push({
              ...group,
              records: current,
              ownership,
              retain: news.retain === true || old?.retain === true,
            });
          }
          for (const old of previous) {
            const key = groupKey(old.projectId, old.dnsZone, old.name, old.type);
            if (!wantedKeys.has(key) && old.ownership === "created" && !old.retain)
              yield* deleteGroup(old);
          }
          yield* session.note(`Upserted ${persisted.length} Scaleway DNS record set(s)`);
          const first = persisted[0];
          return {
            dnsZone: first?.dnsZone,
            projectId: first?.projectId,
            name: first?.name,
            type: first?.type,
            groups: persisted,
            records: persisted.flatMap((group) => group.records),
            names: [...new Set(names)],
          } satisfies DnsRecordListAttributes;
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          for (const group of output.groups)
            if (group.ownership === "created" && !group.retain) yield* deleteGroup(group);
          yield* session.note(
            `Deleted ${output.groups.filter((group) => group.ownership === "created" && !group.retain).length} Scaleway DNS record set(s)`,
          );
        }),
      });
    }),
  );

const projectOption = (options: { readonly [key: string]: unknown } | undefined) => {
  const project = options?.project;
  return project as Input<string> | ProjectRef | undefined;
};

export const ScalewayDnsAdapterLayer = adapterLayer("Scaleway.DNS", {
  alias: (id, args) =>
    DnsRecordList(id, {
      zone: args.zone,
      target: args.target,
      names: [args.name],
      project: projectOption(args.options),
    }),
  aliasSet: (id, args) =>
    DnsRecordList(id, {
      zone: args.zone,
      target: args.target,
      names: args.names,
      project: projectOption(args.options),
    }) as Effect.Effect<DnsAliasSet, never, Providers>,
  records: (id, args) =>
    DnsRecordList(id, {
      zone: args.zone,
      records: args.records,
      retain: args.retain,
      project: projectOption(args.options),
    }),
} satisfies DnsAdapter<Providers>);
