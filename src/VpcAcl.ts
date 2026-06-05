import { Resource } from "alchemy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ScalewayVpcAclRuleRecord } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { resolveRef } from "./Internal.ts";
import type { Providers } from "./Providers.ts";
import type { Vpc } from "./Vpc.ts";

export type VpcAclIpVersion = "ipv4" | "ipv6";
export type VpcAclPolicy = "accept" | "drop";
export type VpcAclProtocol = "ANY" | "TCP" | "UDP" | "ICMP";

export interface VpcAclRule {
  protocol: VpcAclProtocol;
  action: VpcAclPolicy;
  source?: string;
  sourcePort?: number | [number, number];
  destination?: string;
  destinationPort?: number | [number, number];
  description?: string;
}

export interface VpcAclProps {
  vpc: string | Vpc;
  ipVersion?: VpcAclIpVersion;
  defaultPolicy: VpcAclPolicy;
  rules?: VpcAclRule[];
}

export type VpcAcl = Resource<
  "Scaleway.VpcAcl",
  VpcAclProps,
  {
    vpcId: string;
    ipVersion: VpcAclIpVersion;
    defaultPolicy: VpcAclPolicy;
    rules: VpcAclRule[];
  },
  never,
  Providers
>;

export const VpcAcl = Resource<VpcAcl>("Scaleway.VpcAcl");

const vpcIdOf = (vpc: string | Vpc) => resolveRef(typeof vpc === "string" ? vpc : vpc.vpcId);
const ipVersionOf = (props: VpcAclProps) => props.ipVersion ?? "ipv4";
const portLow = (port: number | [number, number] | undefined) =>
  Array.isArray(port) ? port[0] : port;
const portHigh = (port: number | [number, number] | undefined) =>
  Array.isArray(port) ? port[1] : port;
const defaultCidr = (ipVersion: VpcAclIpVersion) => (ipVersion === "ipv6" ? "::/0" : "0.0.0.0/0");
const apiPortLow = (port: number | [number, number] | undefined) => portLow(port) ?? 0;
const apiPortHigh = (port: number | [number, number] | undefined) => portHigh(port) ?? 65535;
const fromApiRule = (rule: ScalewayVpcAclRuleRecord): VpcAclRule => ({
  protocol: rule.protocol as VpcAclProtocol,
  action: rule.action as VpcAclPolicy,
  source: rule.source,
  sourcePort:
    rule.src_port_low === undefined
      ? undefined
      : rule.src_port_low === rule.src_port_high || rule.src_port_high === undefined
        ? rule.src_port_low
        : [rule.src_port_low, rule.src_port_high],
  destination: rule.destination,
  destinationPort:
    rule.dst_port_low === undefined
      ? undefined
      : rule.dst_port_low === rule.dst_port_high || rule.dst_port_high === undefined
        ? rule.dst_port_low
        : [rule.dst_port_low, rule.dst_port_high],
  description: rule.description,
});
const toApiRule = (rule: VpcAclRule, ipVersion: VpcAclIpVersion): ScalewayVpcAclRuleRecord => ({
  protocol: rule.protocol,
  action: rule.action,
  source: rule.source ?? defaultCidr(ipVersion),
  src_port_low: apiPortLow(rule.sourcePort),
  src_port_high: apiPortHigh(rule.sourcePort),
  destination: rule.destination ?? defaultCidr(ipVersion),
  dst_port_low: apiPortLow(rule.destinationPort),
  dst_port_high: apiPortHigh(rule.destinationPort),
  description: rule.description ?? "",
});
const stableRules = (rules: VpcAclRule[] | undefined, ipVersion: VpcAclIpVersion) => {
  const normalized = (rules ?? []).map((rule) => toApiRule(rule, ipVersion));
  return JSON.stringify(normalized);
};

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const VpcAclProvider = () =>
  Provider.effect(
    VpcAcl,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;

      return VpcAcl.Provider.of({
        stables: ["vpcId", "ipVersion"],
        diff: Effect.fnUntraced(function* ({ news, olds, output }) {
          if (!isResolved(news)) return undefined;
          const desiredVpcId = yield* vpcIdOf(news.vpc);
          if (output?.vpcId && output.vpcId !== desiredVpcId) return { action: "replace" } as const;
          if (ipVersionOf(news) !== ipVersionOf(olds)) return { action: "replace" } as const;
          if (
            output?.defaultPolicy !== news.defaultPolicy ||
            stableRules(output?.rules, ipVersionOf(news)) !== stableRules(news.rules, ipVersionOf(news))
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ olds, output }) {
          const vpcId = output?.vpcId ?? (yield* vpcIdOf(olds.vpc));
          const ipVersion = output?.ipVersion ?? ipVersionOf(olds);
          return yield* clients.vpc.getAclRules({ vpcId, ipv6: ipVersion === "ipv6" }).pipe(
            Effect.map((acl) => ({
              vpcId,
              ipVersion,
              defaultPolicy: acl.default_policy as VpcAclPolicy,
              rules: acl.rules.map(fromApiRule),
            })),
            Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
          );
        }),
        reconcile: Effect.fnUntraced(function* ({ news, session }) {
          const vpcId = yield* vpcIdOf(news.vpc);
          const ipVersion = ipVersionOf(news);
          const acl = yield* clients.vpc.setAclRules({
            vpcId,
            ipv6: ipVersion === "ipv6",
            default_policy: news.defaultPolicy,
            rules: (news.rules ?? []).map((rule) => toApiRule(rule, ipVersion)),
          });
          yield* session.note(`Updated Scaleway VPC ACL ${vpcId} (${ipVersion})`);
          return {
            vpcId,
            ipVersion,
            defaultPolicy: acl.default_policy as VpcAclPolicy,
            rules: acl.rules.map(fromApiRule),
          };
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.vpc
            .setAclRules({
              vpcId: output.vpcId,
              ipv6: output.ipVersion === "ipv6",
              default_policy: "accept",
              rules: [],
            })
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Reset Scaleway VPC ACL ${output.vpcId} (${output.ipVersion})`);
        }),
      });
    }),
  );
