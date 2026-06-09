import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import { destroy } from "alchemy/RemovalPolicy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Scaleway from "../src/index.ts";

const region = process.env.SCW_DEFAULT_REGION || "fr-par";
const zone = process.env.SCW_DEFAULT_ZONE || `${region}-1`;
const prefix = process.env.SCW_SMOKE_PREFIX ?? "alchemy-smoke";
const dnsZone = process.env.SCW_SMOKE_DNS_ZONE ?? "alchemy-smoke.finnvid.org";
const dnsDomain = process.env.SCW_SMOKE_DNS_DOMAIN ?? dnsZone.split(".").slice(-2).join(".");
const dnsZoneSubdomain = dnsZone.endsWith(`.${dnsDomain}`) ? dnsZone.slice(0, -dnsDomain.length - 1) : undefined;
const dnsLabel = process.env.SCW_SMOKE_DNS_LABEL ?? prefix;
const domainProjectId = process.env.SCW_DEFAULT_PROJECT_ID;
const organizationId = process.env.SCW_ORGANIZATION_ID;
const smokeHostname = `${dnsLabel}.${dnsZone}`;
const functionDnsLabel = `${dnsLabel.slice(0, 60).replace(/-+$/g, "")}-fn`;
const childZoneLabel = `${dnsLabel.slice(0, 57).replace(/-+$/g, "")}-child`;
const childZoneSubdomain = [childZoneLabel, dnsZoneSubdomain].filter(Boolean).join(".");
const phase = process.env.SCW_SMOKE_PHASE === "create"
  ? "create"
  : process.env.SCW_SMOKE_PHASE === "replace"
  ? "replace"
  : process.env.SCW_SMOKE_PHASE === "settle"
  ? "settle"
  : "update";
const expensiveNetwork = process.env.SCW_SMOKE_EXPENSIVE_NETWORK === "1";
const testSecrets = process.env.SCW_SMOKE_SECRETS === "1";
const functionZipPath = process.env.SCW_SMOKE_FUNCTION_ZIP ?? "scripts/smoke-function/function.zip";
const functionMainPath = process.env.SCW_SMOKE_FUNCTION_MAIN;

const tags = ["alchemy-smoke-test"];
const updatedTags = ["alchemy-smoke-test", "updated"];
const databasePassword = Redacted.make(`AlchemySmokeDb1!${prefix.replace(/[^A-Za-z0-9]/g, "").slice(0, 32) || "default"}`);

export default Alchemy.Stack(
  "alchemy-scaleway-production-smoke",
  {
    providers: Scaleway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    if (!organizationId) throw new Error("SCW_ORGANIZATION_ID is required");
    const updated = phase !== "create";
    const replaced = phase === "replace" || phase === "settle";
    const activeTags = updated ? updatedTags : tags;

    const project = yield* Scaleway.Project("Project", {
      name: `${prefix}-project`,
      organizationId,
      description: updated
        ? "alchemy-scaleway production smoke test updated"
        : "alchemy-scaleway production smoke test",
    });

    const namespace = yield* Scaleway.Namespace("Namespace", {
      name: `${prefix}-ns`,
      description: updated
        ? "alchemy-scaleway production smoke test updated"
        : "alchemy-scaleway production smoke test",
      environmentVariables: { ALCHEMY_SMOKE_TEST: updated ? "updated" : "true" },
    });

    const functionNamespace = yield* Scaleway.FunctionNamespace("FunctionNamespace", {
      name: `${prefix}-fn-ns`,
      description: updated
        ? "alchemy-scaleway production smoke test updated"
        : "alchemy-scaleway production smoke test",
      environmentVariables: { ALCHEMY_SMOKE_TEST: updated ? "updated" : "true" },
      tags: activeTags,
    });

    const registry = yield* Scaleway.RegistryNamespace("Registry", {
      name: `${prefix}-registry`,
      description: updated
        ? "alchemy-scaleway production smoke test updated"
        : "alchemy-scaleway production smoke test",
      public: updated,
    });

    const image = yield* Scaleway.ContainerImage("ContainerImage", {
      registry,
      context: "scripts/smoke-container",
      repository: "nginx-smoke",
      tag: updated ? "updated" : "create",
    });

    const container = yield* Scaleway.Container("Container", {
      namespace,
      name: `${prefix.slice(0, 22)}-ctr`,
      image: image.ref,
      environmentVariables: { ALCHEMY_SMOKE_TEST: "true" },
      port: 80,
      privacy: "public",
    });

    const dnsRecord = yield* Scaleway.DnsRecord("ContainerDns", {
      zone: dnsZone,
      project: domainProjectId,
      name: dnsLabel,
      target: container,
    });

    const childDnsZone = yield* Scaleway.DnsZone("ChildDnsZone", {
      domain: dnsDomain,
      subdomain: childZoneSubdomain,
      project: domainProjectId,
    }).pipe(destroy());

    const domain = updated
      ? yield* Scaleway.Domain("ContainerDomain", {
          container,
          hostname: Output.interpolate`${dnsRecord.name}.${dnsRecord.dnsZone}`,
          waitForCname: true,
        })
      : undefined;

    const secret = testSecrets
      ? yield* Scaleway.Secret("Secret", {
          name: `${prefix}-secret`,
          description: updated
            ? "alchemy-scaleway production smoke test updated"
            : "alchemy-scaleway production smoke test",
          tags: activeTags,
          value: Redacted.make(updated ? "smoke-test-value-updated" : "smoke-test-value"),
        })
      : undefined;

    const database = yield* Scaleway.DatabaseInstance("Database", {
      name: `${prefix}-db`,
      engine: "PostgreSQL-15",
      nodeType: "db-dev-s",
      userName: "alchemy",
      password: databasePassword,
      tags: activeTags,
      volumeType: "sbs_5k",
      volumeSize: 30_000_000_000,
      backupSchedule: {
        disabled: updated,
        frequencyHours: updated ? 48 : 24,
        retentionDays: updated ? 14 : 7,
      },
    }).pipe(destroy());

    const bucket = yield* Scaleway.Bucket("Bucket", {
      name: `${prefix}-bucket`,
      tags: { purpose: "alchemy-smoke-test", phase: updated ? "updated" : "create" },
      versioning: true,
    }).pipe(destroy());

    const vpc = yield* Scaleway.Vpc("Vpc", {
      name: updated ? `${prefix}-vpc-updated` : `${prefix}-vpc`,
      tags: activeTags,
      routing: true,
      customRoutesPropagation: true,
    });

    const targetVpc = expensiveNetwork
      ? yield* Scaleway.Vpc("TargetVpc", {
          name: `${prefix}-target-vpc`,
          tags,
        })
      : undefined;

    const privateNetwork = yield* Scaleway.PrivateNetwork("PrivateNetwork", {
      name: `${prefix}-pn`,
      vpc,
      tags: activeTags,
      dhcp: true,
      defaultRoutePropagation: true,
    });

    const fn = yield* Scaleway.Function("Function", {
      namespace: functionNamespace,
      name: `${prefix.slice(0, 25)}-fn`,
      runtime: "node20",
      handler: functionMainPath ? undefined : "handler.handle",
      source: functionMainPath ? { main: functionMainPath } : { zipPath: functionZipPath },
      environmentVariables: { ALCHEMY_SMOKE_TEST: updated ? "updated" : "true" },
      secretEnvironmentVariables: updated
        ? { TOKEN: Redacted.make("smoke-function-secret-updated") }
        : { TOKEN: Redacted.make("smoke-function-secret"), REMOVE_ME: Redacted.make("removed-on-update") },
      minScale: 0,
      maxScale: 1,
      memoryLimit: 128,
      timeout: updated ? "20s" : "10s",
      privacy: "public",
      description: updated
        ? "alchemy-scaleway production smoke test updated"
        : "alchemy-scaleway production smoke test",
      httpOption: updated ? "redirected" : "enabled",
      tags: activeTags,
      privateNetwork,
      crons: [
        {
          name: `${prefix.slice(0, 25)}-fn-cron`,
          schedule: updated ? "*/15 * * * *" : "*/30 * * * *",
          args: { phase },
        },
      ],
    });

    const functionDnsRecord = yield* Scaleway.DnsRecord("FunctionDns", {
      zone: dnsZone,
      project: domainProjectId,
      name: functionDnsLabel,
      target: fn,
    });

    const functionDomain = updated
      ? yield* Scaleway.FunctionDomain("FunctionDomain", {
          function: fn,
          hostname: Output.interpolate`${functionDnsRecord.name}.${functionDnsRecord.dnsZone}`,
        })
      : undefined;

    const acl = yield* Scaleway.VpcAcl("VpcAcl", {
      vpc,
      defaultPolicy: updated ? "accept" : "drop",
      rules: [
        {
          protocol: "TCP",
          action: "accept",
          source: "0.0.0.0/0",
          destination: "0.0.0.0/0",
          destinationPort: updated ? 80 : 443,
          description: "alchemy-scaleway production smoke test",
        },
      ],
    });

    const route = yield* Scaleway.VpcRoute("VpcRoute", {
      vpc,
      destination: updated ? "10.73.0.0/24" : "10.72.0.0/24",
      nextHop: { type: "privateNetwork", privateNetwork },
      description: updated
        ? "alchemy-scaleway production smoke test updated"
        : "alchemy-scaleway production smoke test",
      tags: activeTags,
    });

    const connector = targetVpc
      ? yield* Scaleway.VpcConnector("VpcConnector", {
          name: updated ? `${prefix}-connector-updated` : `${prefix}-connector`,
          vpc,
          targetVpc,
          tags: activeTags,
        })
      : undefined;

    const securityGroup = yield* Scaleway.SecurityGroup("SecurityGroup", {
      zone,
      name: `${prefix}-sg`,
      description: updated
        ? "alchemy-scaleway production smoke test updated"
        : "alchemy-scaleway production smoke test",
      tags: activeTags,
      inboundDefaultPolicy: "drop",
      outboundDefaultPolicy: "accept",
      stateful: true,
      rules: [
        {
          protocol: "TCP",
          direction: "inbound",
          action: "accept",
          ipRange: "0.0.0.0/0",
          port: 22,
        },
      ],
    });

    const flexibleIp = yield* Scaleway.FlexibleIp("FlexibleIp", {
      zone,
      tags: activeTags,
      type: "routed_ipv4",
    }).pipe(destroy());

    const instance = yield* Scaleway.Instance("Instance", {
      zone,
      name: `${prefix}-instance`,
      commercialType: "DEV1-S",
      image: "ubuntu_noble",
      tags: activeTags,
      securityGroup,
      publicIps: [flexibleIp],
      cloudInit: Redacted.make(`#!/bin/bash
set -e

exec > >(tee /var/log/cloud-init-alchemy-smoke.log) 2>&1

apt-get update
apt-get install -y docker.io

systemctl enable docker
systemctl start docker

echo "Alchemy Scaleway smoke VM setup ${replaced ? "replacement" : "initial"} complete"
`),
      protected: false,
      desiredState: updated ? "running" : "stopped",
    });

    const privateNic = replaced
      ? undefined
      : yield* Scaleway.PrivateNic("PrivateNic", {
          zone,
          serverId: instance.serverId,
          privateNetwork,
          tags: activeTags,
        });

    const managedProjectAssertion = Output.map(
      Output.all(
        project.projectId,
        namespace.projectId,
        registry.projectId,
        functionNamespace.projectId,
        database.projectId,
        vpc.projectId,
        privateNetwork.projectId,
        securityGroup.projectId,
        flexibleIp.projectId,
        instance.projectId,
        ...(secret ? [secret.projectId] : []),
        ...(targetVpc && connector ? [targetVpc.projectId, connector.projectId] : []),
      ),
      ([expected, ...actuals]) => {
        const resources = [
          "namespace",
          "registry",
          "functionNamespace",
          "database",
          "vpc",
          "privateNetwork",
          "securityGroup",
          "flexibleIp",
          "instance",
          ...(secret ? ["secret"] : []),
          ...(targetVpc && connector ? ["targetVpc", "vpcConnector"] : []),
        ];
        for (const [index, actual] of actuals.entries()) {
          if (actual !== expected) throw new Error(`${resources[index]} expected project ${expected}, got ${actual}`);
        }
        return true;
      },
    );
    const dnsProjectAssertion = Output.map(dnsRecord.projectId, (projectId) => {
      if (projectId !== domainProjectId) {
        throw new Error(`dnsRecord expected project ${domainProjectId}, got ${projectId}`);
      }
      return true;
    });

    return {
      managedProjectAssertion,
      dnsProjectAssertion,
      projectId: project.projectId,
      namespaceId: namespace.namespaceId,
      namespaceProjectId: namespace.projectId,
      functionNamespaceId: functionNamespace.namespaceId,
      functionNamespaceProjectId: functionNamespace.projectId,
      functionId: fn.functionId,
      functionUrl: fn.url,
      functionStatus: fn.status,
      functionSourceHash: fn.sourceHash,
      functionCronId: fn.cronTriggers?.[0]?.cronId,
      functionCronSchedule: fn.cronTriggers?.[0]?.schedule,
      functionDnsRecordType: functionDnsRecord.type,
      functionCustomDomainUrl: functionDomain?.url,
      imageRef: image.ref,
      containerUrl: container.url,
      containerProjectId: container.projectId,
      smokeHostname,
      dnsRecordType: dnsRecord.type,
      dnsRecordProjectId: dnsRecord.projectId,
      childDnsZone: childDnsZone.dnsZone,
      childDnsZoneProjectId: childDnsZone.projectId,
      customDomainUrl: domain?.url,
      registryEndpoint: registry.endpoint,
      registryProjectId: registry.projectId,
      secretId: secret?.secretId,
      secretProjectId: secret?.projectId,
      databaseInstanceId: database.databaseInstanceId,
      databaseProjectId: database.projectId,
      databaseStatus: database.status,
      databaseEndpoint: database.endpointHostname ?? database.endpointIp,
      bucketName: bucket.bucketName,
      vpcId: vpc.vpcId,
      vpcProjectId: vpc.projectId,
      targetVpcId: targetVpc?.vpcId,
      targetVpcProjectId: targetVpc?.projectId,
      privateNetworkId: privateNetwork.privateNetworkId,
      privateNetworkProjectId: privateNetwork.projectId,
      aclPolicy: acl.defaultPolicy,
      routeId: route.routeId,
      connectorId: connector?.vpcConnectorId,
      connectorProjectId: connector?.projectId,
      securityGroupId: securityGroup.securityGroupId,
      securityGroupProjectId: securityGroup.projectId,
      flexibleIpId: flexibleIp.ipId,
      flexibleIpProjectId: flexibleIp.projectId,
      instanceId: instance.serverId,
      instanceProjectId: instance.projectId,
      instanceState: instance.state,
      instanceCloudInitHash: instance.cloudInitHash,
      instanceCreatedVolumeIds: instance.createdVolumeIds,
      privateNicId: privateNic?.privateNicId,
    };
  }),
);
