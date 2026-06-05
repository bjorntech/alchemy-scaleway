import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayPrivateNetworkRecord } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { omitUndefined, physicalName, projectId, resolveRef } from "./Internal.ts";
import type { Providers } from "./Providers.ts";
import type { Vpc } from "./Vpc.ts";

export type VpcRef = string | Vpc;

export interface PrivateNetworkProps {
  name?: string;
  projectId?: string;
  vpc?: VpcRef;
  tags?: string[];
  subnets?: string[];
  dhcp?: boolean;
  defaultRoutePropagation?: boolean;
}

export type PrivateNetwork = Resource<
  "Scaleway.PrivateNetwork",
  PrivateNetworkProps,
  {
    privateNetworkId: string;
    name: string;
    projectId: string;
    region: string;
    vpcId?: string;
    tags?: string[];
    subnets?: string[];
    dhcp?: boolean;
    defaultRoutePropagation?: boolean;
  },
  never,
  Providers
>;

export const PrivateNetwork = Resource<PrivateNetwork>("Scaleway.PrivateNetwork");

const sorted = (values: string[] | undefined) => [...(values ?? [])].sort();
const stringsEqual = (left?: string[], right?: string[]) =>
  JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const withAlchemyTag = (id: string, tags: string[] | undefined) => [
  `alchemy:logical-id=${id}`,
  ...(tags ?? []),
];
const vpcIdOf = (vpc: VpcRef | undefined) => {
  if (vpc === undefined) return Effect.succeed(undefined);
  if (typeof vpc === "string") return resolveRef(vpc);
  return resolveRef(vpc.vpcId);
};

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const PrivateNetworkProvider = () =>
  Provider.effect(
    PrivateNetwork,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const nameOf = (id: string, name?: string) => physicalName(id, name, { maxLength: 255 });
      const toAttributes = (record: ScalewayPrivateNetworkRecord): PrivateNetwork["Attributes"] =>
        omitUndefined({
          privateNetworkId: record.id,
          name: record.name,
          projectId: record.project_id,
          region: clients.region,
          vpcId: record.vpc_id,
          tags: record.tags,
          subnets: record.subnets,
          dhcp: record.dhcp_enabled,
          defaultRoutePropagation: record.default_route_propagation_enabled,
        }) as PrivateNetwork["Attributes"];

      const syncSubnets = (privateNetworkId: string, desired: string[] | undefined) =>
        Effect.gen(function* () {
          const current = yield* clients.vpc.getPrivateNetwork(privateNetworkId);
          const currentSet = new Set(current.subnets ?? []);
          const desiredSet = new Set(desired ?? []);
          for (const subnet of desiredSet) {
            if (!currentSet.has(subnet)) yield* clients.vpc.addPrivateNetworkSubnet(privateNetworkId, subnet);
          }
          for (const subnet of currentSet) {
            if (!desiredSet.has(subnet)) yield* clients.vpc.deletePrivateNetworkSubnet(privateNetworkId, subnet);
          }
          return yield* clients.vpc.getPrivateNetwork(privateNetworkId);
        });

      return PrivateNetwork.Provider.of({
        stables: ["privateNetworkId", "projectId", "region", "vpcId"],
        diff: Effect.fnUntraced(function* ({ id, news, output }) {
          if (!isResolved(news) || !output) return undefined;
          if ((yield* projectId(news.projectId)) !== output.projectId) return { action: "replace" } as const;
          const desiredVpcId = yield* vpcIdOf(news.vpc);
          if (desiredVpcId !== output.vpcId) return { action: "replace" } as const;
          const name = yield* nameOf(id, news.name);
          const tags = withAlchemyTag(id, news.tags);
          if (
            output.name !== name ||
            !stringsEqual(output.tags, tags) ||
            (news.subnets !== undefined && !stringsEqual(output.subnets, news.subnets)) ||
            (news.dhcp !== undefined && output.dhcp !== news.dhcp) ||
            (news.defaultRoutePropagation !== undefined &&
              output.defaultRoutePropagation !== news.defaultRoutePropagation)
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.privateNetworkId) return undefined;
          return yield* clients.vpc.getPrivateNetwork(output.privateNetworkId).pipe(
            Effect.map(toAttributes),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          const name = yield* nameOf(id, news.name);
          const tags = withAlchemyTag(id, news.tags);
          let record = output?.privateNetworkId
            ? yield* clients.vpc.updatePrivateNetwork(output.privateNetworkId, {
                name,
                tags,
                default_route_propagation_enabled: news.defaultRoutePropagation,
              })
            : yield* clients.vpc.createPrivateNetwork({
                name,
                project_id: yield* projectId(news.projectId),
                vpc_id: yield* vpcIdOf(news.vpc),
                tags,
                subnets: news.subnets,
                default_route_propagation_enabled: news.defaultRoutePropagation,
              });

          if (output?.privateNetworkId && news.subnets !== undefined) {
            record = yield* syncSubnets(record.id, news.subnets);
          }
          if (news.dhcp === true && record.dhcp_enabled !== true) {
            record = yield* clients.vpc.enablePrivateNetworkDhcp(record.id);
          }
          if (news.dhcp === false && record.dhcp_enabled === true) {
            throw new Error("Scaleway Private Network DHCP cannot be disabled once enabled.");
          }

          yield* session.note(
            `${output?.privateNetworkId ? "Updated" : "Created"} Scaleway private network ${record.id}`,
          );
          return toAttributes(record);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.vpc
            .deletePrivateNetwork(output.privateNetworkId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway private network ${output.privateNetworkId}`);
        }),
      });
    }),
  );
