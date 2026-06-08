import { Resource } from "alchemy";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayFlexibleIpRecord } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { omitUndefined, projectId, projectInput, withManagedProjectDefault, type ProjectRef } from "./Internal.ts";
import type { Providers } from "./Providers.ts";

export type FlexibleIpType = "routed_ipv4" | "routed_ipv6";

export interface FlexibleIpProps {
  zone?: string;
  project?: ProjectRef;
  tags?: string[];
  serverId?: string;
  type?: FlexibleIpType;
  reverse?: string;
}

export type FlexibleIp = Resource<
  "Scaleway.FlexibleIp",
  FlexibleIpProps,
  {
    ipId: string;
    address: string;
    zone: string;
    projectId?: string;
    tags?: string[];
    serverId?: string;
    type?: string;
    reverse?: string;
    state?: string;
    prefix?: string;
    ipamId?: string;
  },
  never,
  Providers
>;

export const FlexibleIp = withManagedProjectDefault(Resource<FlexibleIp>("Scaleway.FlexibleIp", {
  defaultRemovalPolicy: "retain",
}));

const stringsEqual = (left?: string[], right?: string[]) => JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());
const withAlchemyTag = (id: string, tags: string[] | undefined) => [`alchemy:logical-id=${id}`, ...(tags ?? [])];
const hasAlchemyTag = (id: string, tags: string[] | undefined) => (tags ?? []).includes(`alchemy:logical-id=${id}`);
const zoneOf = (region: string, zone?: string) => !zone || zone === region ? `${region}-1` : zone;

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const FlexibleIpProvider = () =>
  Provider.effect(
    FlexibleIp,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const toAttributes = (record: ScalewayFlexibleIpRecord): FlexibleIp["Attributes"] =>
        omitUndefined({
          ipId: record.id,
          address: record.address,
          zone: zoneOf(clients.region, record.zone),
          projectId: record.project,
          tags: record.tags,
          serverId: record.server?.id,
          type: record.type,
          reverse: record.reverse ?? undefined,
          state: record.state,
          prefix: record.prefix ?? undefined,
          ipamId: record.ipam_id,
        }) as FlexibleIp["Attributes"];

      return FlexibleIp.Provider.of({
        stables: ["ipId", "address", "zone", "projectId"],
        diff: Effect.fnUntraced(function* ({ id, news, output }) {
          if (!isResolved(news) || !output) return undefined;
          if (zoneOf(clients.region, output.zone) !== zoneOf(clients.region, news.zone) || output.type !== (news.type ?? "routed_ipv4")) return { action: "replace" } as const;
          if (output.projectId !== (yield* projectId(projectInput(news), output.projectId))) return { action: "replace" } as const;
          if (!stringsEqual(output.tags, withAlchemyTag(id, news.tags)) || output.serverId !== news.serverId || output.reverse !== news.reverse) return { action: "update" } as const;
          return { action: "noop" } as const;
        }),
        read: Effect.fnUntraced(function* ({ id, olds, output }) {
          if (output?.ipId) {
            return yield* clients.instance.getFlexibleIp({ zone: zoneOf(clients.region, output.zone), ip: output.ipId }).pipe(
              Effect.map(toAttributes),
              Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
            );
          }
          const zone = zoneOf(clients.region, olds.zone);
          const resolvedProjectId = yield* projectId(projectInput(olds));
          const found = yield* clients.instance.listFlexibleIps({ zone, project: resolvedProjectId }).pipe(
            Effect.map((ips) => ips.find((ip) => hasAlchemyTag(id, ip.tags))),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
          if (!found) return undefined;
          const attrs = toAttributes(found);
          return hasAlchemyTag(id, found.tags) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          const zone = zoneOf(clients.region, news.zone);
          const tags = withAlchemyTag(id, news.tags);
          const resolvedProjectId = yield* projectId(projectInput(news), output?.projectId);
          let record: ScalewayFlexibleIpRecord;
          if (output?.ipId) {
            record = yield* clients.instance.updateFlexibleIp({ zone, ip: output.ipId, tags, server: news.serverId ?? null, reverse: news.reverse ?? null });
          } else {
            const found = yield* clients.instance.listFlexibleIps({ zone, project: resolvedProjectId }).pipe(
              Effect.map((ips) => ips.find((ip) =>
                hasAlchemyTag(id, ip.tags) &&
                zoneOf(clients.region, ip.zone) === zone &&
                ip.project === resolvedProjectId &&
                ip.type === (news.type ?? "routed_ipv4")
              )),
              Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
            );
            if (found) {
              record = yield* clients.instance.updateFlexibleIp({ zone, ip: found.id, tags, server: news.serverId ?? null, reverse: news.reverse ?? null });
            } else {
              record = yield* clients.instance.createFlexibleIp({ zone, project: resolvedProjectId, tags, server: news.serverId, type: news.type ?? "routed_ipv4" });
            }
            if (!found && news.reverse !== undefined) {
              record = yield* clients.instance.updateFlexibleIp({ zone, ip: record.id, tags, server: news.serverId ?? null, reverse: news.reverse }).pipe(
                Effect.catch((error) =>
                  clients.instance.deleteFlexibleIp({ zone, ip: record.id }).pipe(
                    Effect.catchIf(isNotFound, () => Effect.void),
                    Effect.flatMap(() => Effect.fail(error)),
                  ),
                ),
              );
            }
          }
          yield* session.note(`${output?.ipId ? "Updated" : "Created"} Scaleway flexible IP ${record.id}`);
          return toAttributes(record);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.instance.deleteFlexibleIp({ zone: zoneOf(clients.region, output.zone), ip: output.ipId }).pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway flexible IP ${output.ipId}`);
        }),
      });
    }),
  );
