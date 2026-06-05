import { AwsClient } from "aws4fetch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Buffer } from "node:buffer";
import { makeScalewayClients, type ScalewayContainerRecord } from "../src/Clients.ts";
import { ScalewayCredentials } from "../src/Credentials.ts";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

if (process.env.SCW_LIVE_TEST !== "1") {
  throw new Error("Set SCW_LIVE_TEST=1 to run the live Scaleway production smoke test");
}

const accessKey = required("SCW_ACCESS_KEY");
const secretKey = required("SCW_SECRET_KEY");
const region = process.env.SCW_DEFAULT_REGION || "fr-par";
const projectId = required("SCW_DEFAULT_PROJECT_ID");
const apiUrl = process.env.SCW_API_URL || "https://api.scaleway.com";
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const prefix = `alchemy-smoke-${suffix}`;
const containerName = `alchemy-smoke-${Date.now().toString(36).slice(-8)}-${crypto.randomUUID().slice(0, 7)}-ctr`;
const bucketName = `${prefix}-bucket`;

const credentialsLayer = Layer.succeed(
  ScalewayCredentials,
  ScalewayCredentials.of({
    secretKey: Redacted.make(secretKey),
    accessKey,
    projectId,
    region,
    apiUrl,
  }),
);

const clients = await Effect.runPromise(makeScalewayClients.pipe(Effect.provide(credentialsLayer)));
const created: {
  namespaceId?: string;
  containerId?: string;
  registryNamespaceId?: string;
  secretId?: string;
  bucketName?: string;
  vpcId?: string;
  privateNetworkId?: string;
} = {};

async function runEffect<A>(effect: Effect.Effect<A, unknown>) {
  return await Effect.runPromise(effect);
}

async function restDelete(path: string, label: string) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "DELETE",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Auth-Token": secretKey,
    },
  });
  if (response.ok || response.status === 404) {
    console.log(`deleted ${label}`);
    return;
  }
  const body = await response.text();
  console.error(`failed deleting ${label}: ${response.status} ${body}`);
}

async function deleteBucket(name: string) {
  const client = new AwsClient({
    accessKeyId: accessKey,
    secretAccessKey: secretKey,
    service: "s3",
    region,
  });
  const response = await client.fetch(`https://s3.${region}.scw.cloud/${name}/`, {
    method: "DELETE",
  });
  if (response.ok || response.status === 404) {
    console.log(`deleted bucket ${name}`);
    return;
  }
  const body = await response.text();
  console.error(`failed deleting bucket ${name}: ${response.status} ${body}`);
}

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForContainerReady(containerId: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const container = await runEffect(clients.containers.getContainer(containerId));
    const status = container.status?.toLowerCase();
    if (status === "error" || status === "failed") {
      throw new Error(`container ${containerId} entered ${container.status} status`);
    }
    if (container.public_endpoint || status === "ready") return container;
    await sleep(2000);
  }
  throw new Error(`timed out waiting for container ${containerId}`);
}

async function waitForNamespaceReady(namespaceId: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const namespace = await runEffect(clients.containers.getNamespace(namespaceId));
    const status = namespace.status?.toLowerCase();
    if (status === "error" || status === "failed") {
      throw new Error(`namespace ${namespaceId} entered ${namespace.status} status`);
    }
    console.log(`namespace status ${status ?? "unknown"}`);
    if (status === "ready") return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for namespace ${namespaceId}`);
}

function containerUrl(container: ScalewayContainerRecord) {
  if (!container.public_endpoint) return undefined;
  return container.public_endpoint.startsWith("http")
    ? container.public_endpoint
    : `https://${container.public_endpoint}`;
}

try {
  const namespace = await runEffect(
    clients.containers.createNamespace({
      name: `${prefix}-ns`,
      project_id: projectId,
      description: "alchemy-scaleway production smoke test",
      environment_variables: { ALCHEMY_SMOKE_TEST: "true" },
    }),
  );
  created.namespaceId = namespace.id;
  console.log(`created namespace ${namespace.id}`);
  await waitForNamespaceReady(namespace.id);

  const container = await runEffect(
    clients.containers.createContainer({
      namespace_id: namespace.id,
      name: containerName,
      image: "docker.io/library/nginx:latest",
      environment_variables: { ALCHEMY_SMOKE_TEST: "true" },
    }),
  );
  created.containerId = container.id;
  console.log(`created container ${container.id}`);

  const readyContainer = await waitForContainerReady(container.id);
  console.log(`container ready ${containerUrl(readyContainer) ?? readyContainer.status ?? container.id}`);

  const registry = await runEffect(
    clients.registry.createNamespace({
      name: `${prefix}-registry`,
      project_id: projectId,
      description: "alchemy-scaleway production smoke test",
      is_public: false,
    }),
  );
  created.registryNamespaceId = registry.id;
  console.log(`created registry namespace ${registry.id}`);

  const secret = await runEffect(
    clients.secretManager.createSecret({
      name: `${prefix}-secret`,
      project_id: projectId,
      description: "alchemy-scaleway production smoke test",
      tags: ["alchemy-smoke-test"],
      type: "opaque",
      path: "/",
    }),
  );
  created.secretId = secret.id;
  console.log(`created secret ${secret.id}`);

  const version = await runEffect(
    clients.secretManager.createVersion(secret.id, {
      data: Buffer.from("smoke-test-value", "utf8").toString("base64"),
      description: "alchemy-scaleway production smoke test",
      disable_previous: true,
    }),
  );
  console.log(`created secret version ${version.revision}`);

  const bucket = await runEffect(
    clients.objectStorage.createBucket({
      name: bucketName,
      region,
      tags: { purpose: "alchemy-smoke-test" },
      versioning: true,
    }),
  );
  created.bucketName = bucket.name;
  console.log(`created bucket ${bucket.name}`);

  const vpc = await runEffect(
    clients.vpc.createVpc({
      name: `${prefix}-vpc`,
      project_id: projectId,
      tags: ["alchemy-smoke-test"],
    }),
  );
  created.vpcId = vpc.id;
  console.log(`created vpc ${vpc.id}`);

  const routedVpc = await runEffect(clients.vpc.enableVpcRouting(vpc.id));
  console.log(`enabled vpc routing ${routedVpc.routing_enabled === true}`);

  const updatedVpc = await runEffect(
    clients.vpc.updateVpc(vpc.id, {
      name: `${prefix}-vpc-updated`,
      tags: ["alchemy-smoke-test", "updated"],
    }),
  );
  console.log(`updated vpc ${updatedVpc.id}`);

  const privateNetwork = await runEffect(
    clients.vpc.createPrivateNetwork({
      name: `${prefix}-pn`,
      project_id: projectId,
      vpc_id: vpc.id,
      tags: ["alchemy-smoke-test"],
      subnets: ["10.71.0.0/24"],
      default_route_propagation_enabled: true,
    }),
  );
  created.privateNetworkId = privateNetwork.id;
  console.log(`created private network ${privateNetwork.id}`);

  const dhcpPrivateNetwork = await runEffect(
    clients.vpc.enablePrivateNetworkDhcp(privateNetwork.id),
  );
  console.log(`enabled private network dhcp ${dhcpPrivateNetwork.dhcp_enabled === true}`);
  console.log(`private network subnets ${dhcpPrivateNetwork.subnets?.join(",")}`);

  const acl = await runEffect(
    clients.vpc.setAclRules({
      vpcId: vpc.id,
      ipv6: false,
      default_policy: "drop",
      rules: [
        {
          protocol: "TCP",
          action: "accept",
          source: "0.0.0.0/0",
          src_port_low: 0,
          src_port_high: 65535,
          destination: "0.0.0.0/0",
          dst_port_low: 443,
          dst_port_high: 443,
          description: "alchemy-scaleway production smoke test",
        },
      ],
    }),
  );
  console.log(`set vpc acl ${acl.default_policy} ${acl.rules.length} rule(s)`);

  const readAcl = await runEffect(clients.vpc.getAclRules({ vpcId: vpc.id, ipv6: false }));
  console.log(`read vpc acl ${readAcl.default_policy} ${readAcl.rules.length} rule(s)`);

  console.log("production smoke test create/read paths succeeded");
} finally {
  if (created.vpcId) {
    await runEffect(
      clients.vpc.setAclRules({
        vpcId: created.vpcId,
        ipv6: false,
        default_policy: "accept",
        rules: [],
      }),
    ).catch((error) => console.error(`failed resetting vpc acl ${created.vpcId}: ${error}`));
  }
  if (created.privateNetworkId) {
    await restDelete(
      `/vpc/v2/regions/${region}/private-networks/${created.privateNetworkId}`,
      `private network ${created.privateNetworkId}`,
    );
  }
  if (created.vpcId) {
    await restDelete(`/vpc/v2/regions/${region}/vpcs/${created.vpcId}`, `vpc ${created.vpcId}`);
  }
  if (created.bucketName) await deleteBucket(created.bucketName);
  if (created.secretId) {
    await restDelete(
      `/secret-manager/v1beta1/regions/${region}/secrets/${created.secretId}`,
      `secret ${created.secretId}`,
    );
  }
  if (created.registryNamespaceId) {
    await restDelete(
      `/registry/v1/regions/${region}/namespaces/${created.registryNamespaceId}`,
      `registry namespace ${created.registryNamespaceId}`,
    );
  }
  if (created.containerId) {
    await restDelete(
      `/containers/v1/regions/${region}/containers/${created.containerId}`,
      `container ${created.containerId}`,
    );
  }
  if (created.namespaceId) {
    await restDelete(
      `/containers/v1/regions/${region}/namespaces/${created.namespaceId}`,
      `namespace ${created.namespaceId}`,
    );
  }
}
