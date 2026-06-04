import { AwsClient } from "aws4fetch";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Buffer } from "node:buffer";
import { makeScalewayClients } from "../src/Clients.ts";
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
  registryNamespaceId?: string;
  secretId?: string;
  bucketName?: string;
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

  console.log("production smoke test create/read paths succeeded");
} finally {
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
  if (created.namespaceId) {
    await restDelete(
      `/containers/v1/regions/${region}/namespaces/${created.namespaceId}`,
      `namespace ${created.namespaceId}`,
    );
  }
}
