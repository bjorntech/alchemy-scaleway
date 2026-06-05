import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayVpcConnectorRecord } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { omitUndefined, physicalName, resolveRef } from "./Internal.ts";
import type { Providers } from "./Providers.ts";
import type { Vpc } from "./Vpc.ts";

export type VpcConnectorVpcRef = string | Vpc;

export interface VpcConnectorProps {
  name?: string;
  vpc: VpcConnectorVpcRef;
  targetVpc: VpcConnectorVpcRef;
  tags?: string[];
}

export type VpcConnector = Resource<
  "Scaleway.VpcConnector",
  VpcConnectorProps,
  {
    vpcConnectorId: string;
    name: string;
    region: string;
    projectId?: string;
    vpcId: string;
    targetVpcId: string;
    status?: string;
    peerInfo?: ScalewayVpcConnectorRecord["peer_info"];
    tags?: string[];
  },
  never,
  Providers
>;

export const VpcConnector = Resource<VpcConnector>("Scaleway.VpcConnector");

const stringsEqual = (left?: string[], right?: string[]) =>
  JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());
const withAlchemyTag = (id: string, tags: string[] | undefined) => [
  `alchemy:logical-id=${id}`,
  ...(tags ?? []),
];
const vpcIdOf = (vpc: VpcConnectorVpcRef) => {
  if (typeof vpc === "string") return resolveRef(vpc);
  return resolveRef(vpc.vpcId);
};

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const VpcConnectorProvider = () =>
  Provider.effect(
    VpcConnector,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const nameOf = (id: string, name?: string) => physicalName(id, name, { maxLength: 255 });
      const toAttributes = (record: ScalewayVpcConnectorRecord): VpcConnector["Attributes"] =>
        omitUndefined({
          vpcConnectorId: record.id,
          name: record.name,
          region: clients.region,
          projectId: record.project_id,
          vpcId: record.vpc_id,
          targetVpcId: record.target_vpc_id,
          status: record.status,
          peerInfo: record.peer_info ?? undefined,
          tags: record.tags,
        }) as VpcConnector["Attributes"];

      return VpcConnector.Provider.of({
        stables: ["vpcConnectorId", "region", "vpcId", "targetVpcId"],
        diff: Effect.fnUntraced(function* ({ id, news, output }) {
          if (!isResolved(news) || !output) return undefined;
          const vpcId = yield* vpcIdOf(news.vpc);
          const targetVpcId = yield* vpcIdOf(news.targetVpc);
          if (output.vpcId !== vpcId || output.targetVpcId !== targetVpcId) {
            return { action: "replace" } as const;
          }
          const name = yield* nameOf(id, news.name);
          const tags = withAlchemyTag(id, news.tags);
          if (output.name !== name || !stringsEqual(output.tags, tags)) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ output }) {
          if (!output?.vpcConnectorId) return undefined;
          return yield* clients.vpc.getVpcConnector(output.vpcConnectorId).pipe(
            Effect.map(toAttributes),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          const name = yield* nameOf(id, news.name);
          const tags = withAlchemyTag(id, news.tags);
          const record = output?.vpcConnectorId
            ? yield* clients.vpc.updateVpcConnector(output.vpcConnectorId, { name, tags })
            : yield* clients.vpc.createVpcConnector({
                name,
                tags,
                vpc_id: yield* vpcIdOf(news.vpc),
                target_vpc_id: yield* vpcIdOf(news.targetVpc),
              });
          yield* session.note(
            `${output?.vpcConnectorId ? "Updated" : "Created"} Scaleway VPC connector ${record.id}`,
          );
          return toAttributes(record);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.vpc
            .deleteVpcConnector(output.vpcConnectorId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway VPC connector ${output.vpcConnectorId}`);
        }),
      });
    }),
  );
