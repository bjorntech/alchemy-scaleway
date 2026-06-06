import { AwsClient } from "aws4fetch";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ScalewayCredentials } from "./Credentials.ts";
import { isNotFound, ScalewayError, scalewayError } from "./Errors.ts";
import { omitUndefined } from "./Internal.ts";

export interface ScalewayNamespaceRecord {
  id: string;
  name: string;
  project_id: string;
  region?: string;
  description?: string;
  environment_variables?: Record<string, string>;
  status?: string;
}

export interface ScalewayContainerRecord {
  id: string;
  name: string;
  namespace_id: string;
  project_id?: string;
  region?: string;
  status?: string;
  public_endpoint?: string;
  image?: string;
  min_scale?: number;
  max_scale?: number;
  mvcpu_limit?: number;
  memory_limit_bytes?: number;
  timeout?: number;
  privacy?: string;
  protocol?: string;
  port?: number;
  https_connections_only?: boolean;
  environment_variables?: Record<string, string>;
}

export interface ScalewayTriggerCronConfig {
  schedule: string;
  timezone?: string;
  body?: string;
  headers?: Record<string, string>;
}

export interface ScalewayTriggerSqsConfig {
  region?: string;
  endpoint?: string;
  access_key_id?: string;
  /** Write-only: provided on create/update, never returned by reads. */
  secret_access_key?: string;
  queue_url?: string;
}

export interface ScalewayTriggerNatsConfig {
  server_urls?: string[];
  subject?: string;
  /** Write-only: provided on create/update, never returned by reads. */
  credentials_file_content?: string;
}

export interface ScalewayTriggerDestinationConfig {
  http_path?: string;
  http_method?: string;
}

export interface ScalewayTriggerRecord {
  id: string;
  container_id: string;
  name?: string;
  description?: string;
  status?: string;
  source_type?: string;
  destination_config?: ScalewayTriggerDestinationConfig;
  cron_config?: ScalewayTriggerCronConfig;
  sqs_config?: ScalewayTriggerSqsConfig;
  nats_config?: ScalewayTriggerNatsConfig;
}

export interface ScalewayCreateTriggerInput {
  container_id: string;
  name?: string;
  description?: string;
  destination_config?: ScalewayTriggerDestinationConfig;
  cron_config?: ScalewayTriggerCronConfig;
  sqs_config?: ScalewayTriggerSqsConfig;
  nats_config?: ScalewayTriggerNatsConfig;
}

export interface ScalewayUpdateTriggerInput {
  name?: string;
  description?: string;
  destination_config?: ScalewayTriggerDestinationConfig;
  cron_config?: Partial<ScalewayTriggerCronConfig>;
  sqs_config?: ScalewayTriggerSqsConfig;
  nats_config?: ScalewayTriggerNatsConfig;
}

export interface ScalewayDomainRecord {
  id: string;
  container_id: string;
  hostname: string;
  status?: string;
  error_message?: string;
}

export interface ScalewayDnsZoneRecord {
  domain: string;
  subdomain?: string;
  ns?: string[];
  ns_default?: string[];
  ns_master?: string[];
  status?: string;
  message?: string | null;
  updated_at?: string | null;
  project_id?: string;
  linked_products?: string[];
}

export interface ScalewayProjectRecord {
  id: string;
  name: string;
  organization_id: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
}

export type ScalewayDnsRecordType =
  | "A"
  | "AAAA"
  | "CNAME"
  | "TXT"
  | "SRV"
  | "TLSA"
  | "MX"
  | "NS"
  | "PTR"
  | "CAA"
  | "ALIAS"
  | "LOC"
  | "SSHFP"
  | "HINFO"
  | "RP"
  | "URI"
  | "DS"
  | "NAPTR"
  | "DNAME"
  | "SVCB"
  | "HTTPS";

export interface ScalewayDnsRecord {
  id?: string;
  name: string;
  type: ScalewayDnsRecordType;
  data: string;
  ttl?: number;
  priority?: number;
  comment?: string | null;
  updated_at?: string | null;
}

export interface ScalewayDnsRecordIdentifier {
  name: string;
  type: ScalewayDnsRecordType;
  data?: string;
  ttl?: number;
}

export type ScalewayDnsRecordChange =
  | { add: { records: ScalewayDnsRecord[] } }
  | { set: { id?: string; id_fields?: ScalewayDnsRecordIdentifier; records: ScalewayDnsRecord[] } }
  | { delete: { id?: string; id_fields?: ScalewayDnsRecordIdentifier } }
  | { clear: Record<string, never> };

export interface ScalewayRegistryNamespaceRecord {
  id: string;
  name: string;
  project_id: string;
  region?: string;
  description?: string;
  is_public?: boolean;
  endpoint?: string;
  status?: string;
}

export interface ScalewaySecretEphemeralPolicy {
  time_to_live?: string | null;
  expires_once_accessed?: boolean | null;
  action?: "delete" | "disable";
}

export interface ScalewaySecretRecord {
  id: string;
  project_id: string;
  name: string;
  status?: string;
  tags?: string[];
  version_count?: number;
  description?: string | null;
  protected?: boolean;
  type?: string;
  path?: string;
  region?: string;
  ephemeral_policy?: ScalewaySecretEphemeralPolicy;
  key_id?: string | null;
}

export interface ScalewaySecretVersionRecord {
  revision: number;
  secret_id: string;
  status?: string;
  description?: string | null;
  latest?: boolean;
  region?: string;
}

export interface ScalewayRdbEndpointRecord {
  ip?: string;
  port?: number;
  name?: string | null;
  hostname?: string;
  private_network?: { id?: string } | null;
}

export interface ScalewayRdbVolumeRecord {
  type?: string;
  size?: number;
}

export interface ScalewayRdbInstanceRecord {
  id: string;
  name: string;
  project_id: string;
  region?: string;
  status?: string;
  engine?: string;
  node_type?: string;
  is_ha_cluster?: boolean;
  tags?: string[];
  endpoint?: ScalewayRdbEndpointRecord | null;
  endpoints?: ScalewayRdbEndpointRecord[];
  volume?: ScalewayRdbVolumeRecord;
  backup_schedule?: { disabled?: boolean; frequency?: number; retention?: number };
  created_at?: string;
  updated_at?: string;
}

export interface ObjectStorageBucketRecord {
  name: string;
  region: string;
  endpoint: string;
  tags?: Record<string, string>;
  versioning?: boolean;
}

export interface ScalewayVpcRecord {
  id: string;
  name: string;
  project_id: string;
  region?: string;
  tags?: string[];
  routing_enabled?: boolean;
  custom_routes_propagation_enabled?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface ScalewayPrivateNetworkRecord {
  id: string;
  name: string;
  project_id: string;
  region?: string;
  vpc_id?: string;
  tags?: string[];
  subnets?: string[];
  dhcp_enabled?: boolean;
  default_route_propagation_enabled?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface ScalewayVpcAclRuleRecord {
  protocol: string;
  action: string;
  source?: string;
  src_port_low?: number;
  src_port_high?: number;
  destination?: string;
  dst_port_low?: number;
  dst_port_high?: number;
  description?: string;
}

export interface ScalewayVpcAclRecord {
  default_policy: string;
  rules: ScalewayVpcAclRuleRecord[];
}

export interface ScalewayVpcRouteRecord {
  id: string;
  description?: string;
  tags?: string[];
  vpc_id: string;
  destination: string;
  nexthop_resource_id?: string | null;
  nexthop_private_network_id?: string | null;
  nexthop_vpc_connector_id?: string | null;
  is_read_only?: boolean;
  type?: string;
  region?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ScalewayVpcConnectorPeerInfo {
  organization_id?: string;
  project_id?: string;
  vpc_name?: string;
}

export interface ScalewayVpcConnectorRecord {
  id: string;
  name: string;
  project_id?: string;
  vpc_id: string;
  target_vpc_id: string;
  status?: string;
  peer_info?: ScalewayVpcConnectorPeerInfo | null;
  region?: string;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface ScalewaySecurityGroupRecord {
  id: string;
  name: string;
  description?: string | null;
  project?: string;
  tags?: string[];
  inbound_default_policy?: string;
  outbound_default_policy?: string;
  stateful?: boolean;
  project_default?: boolean;
  enable_default_security?: boolean;
  state?: string;
  zone?: string;
}

export interface ScalewaySecurityGroupRuleRecord {
  id?: string;
  protocol: string;
  direction: string;
  action: string;
  ip_range: string;
  dest_port_from?: number;
  dest_port_to?: number | null;
  position?: number;
  editable?: boolean;
  zone?: string;
}

export interface ScalewayFlexibleIpRecord {
  id: string;
  address: string;
  reverse?: string;
  server?: { id: string; name?: string } | null;
  tags?: string[];
  project?: string;
  type?: string;
  state?: string;
  prefix?: string;
  ipam_id?: string;
  zone?: string;
}

export interface ScalewayPrivateNicRecord {
  id: string;
  server_id: string;
  private_network_id: string;
  mac_address?: string;
  state?: string;
  tags?: string[];
  zone?: string;
  ipam_ip_ids?: string[];
}

export interface ScalewayInstanceVolumeRecord {
  id?: string;
  name?: string | null;
  size?: number | null;
  volume_type?: string;
  boot?: boolean;
  project?: string | null;
  zone?: string;
}

export interface ScalewayInstanceIpRecord {
  id?: string;
  address?: string;
  family?: string;
  dynamic?: boolean;
  state?: string;
}

export interface ScalewayInstanceRecord {
  id: string;
  name: string;
  project?: string;
  tags?: string[];
  commercial_type: string;
  dynamic_ip_required?: boolean;
  routed_ip_enabled?: boolean;
  enable_ipv6?: boolean;
  image?: { id?: string; name?: string } | null;
  protected?: boolean;
  public_ips?: ScalewayInstanceIpRecord[];
  state?: string;
  boot_type?: string;
  volumes?: Record<string, ScalewayInstanceVolumeRecord>;
  security_group?: { id: string; name?: string } | null;
  placement_group?: { id: string; name?: string } | null;
  private_nics?: ScalewayPrivateNicRecord[];
  zone?: string;
  dns?: string | null;
  allowed_actions?: string[];
}

export interface ScalewayClients {
  region: string;
  projectId?: string;
  account: {
    createProject(input: {
      name: string;
      organization_id: string;
      description?: string;
    }): Effect.Effect<ScalewayProjectRecord, ScalewayError>;
    getProject(projectId: string): Effect.Effect<ScalewayProjectRecord, ScalewayError>;
    updateProject(
      projectId: string,
      input: {
        name?: string;
        organization_id: string;
        description?: string;
      },
    ): Effect.Effect<ScalewayProjectRecord, ScalewayError>;
    deleteProject(projectId: string): Effect.Effect<void, ScalewayError>;
  };
  containers: {
    createNamespace(input: {
      name: string;
      project_id: string;
      description?: string;
      environment_variables?: Record<string, string>;
    }): Effect.Effect<ScalewayNamespaceRecord, ScalewayError>;
    getNamespace(namespaceId: string): Effect.Effect<ScalewayNamespaceRecord, ScalewayError>;
    updateNamespace(
      namespaceId: string,
      input: {
        name?: string;
        description?: string;
        environment_variables?: Record<string, string>;
      },
    ): Effect.Effect<ScalewayNamespaceRecord, ScalewayError>;
    deleteNamespace(namespaceId: string): Effect.Effect<void, ScalewayError>;
    createContainer(
      input: Record<string, unknown>,
    ): Effect.Effect<ScalewayContainerRecord, ScalewayError>;
    getContainer(containerId: string): Effect.Effect<ScalewayContainerRecord, ScalewayError>;
    updateContainer(
      containerId: string,
      input: Record<string, unknown>,
    ): Effect.Effect<ScalewayContainerRecord, ScalewayError>;
    deleteContainer(containerId: string): Effect.Effect<void, ScalewayError>;
    createTrigger(
      input: ScalewayCreateTriggerInput,
    ): Effect.Effect<ScalewayTriggerRecord, ScalewayError>;
    getTrigger(triggerId: string): Effect.Effect<ScalewayTriggerRecord, ScalewayError>;
    updateTrigger(
      triggerId: string,
      input: ScalewayUpdateTriggerInput,
    ): Effect.Effect<ScalewayTriggerRecord, ScalewayError>;
    deleteTrigger(triggerId: string): Effect.Effect<void, ScalewayError>;
    createDomain(input: {
      container_id: string;
      hostname: string;
    }): Effect.Effect<ScalewayDomainRecord, ScalewayError>;
    getDomain(domainId: string): Effect.Effect<ScalewayDomainRecord, ScalewayError>;
    deleteDomain(domainId: string): Effect.Effect<void, ScalewayError>;
  };
  dns: {
    listZones(input: { domain?: string; dnsZone?: string; projectId?: string }): Effect.Effect<ScalewayDnsZoneRecord[], ScalewayError>;
    createZone(input: { domain: string; subdomain: string; project_id: string }): Effect.Effect<ScalewayDnsZoneRecord, ScalewayError>;
    updateZone(input: { dnsZone: string; new_dns_zone: string; project_id: string }): Effect.Effect<ScalewayDnsZoneRecord, ScalewayError>;
    deleteZone(input: { dnsZone: string; projectId: string }): Effect.Effect<void, ScalewayError>;
    listRecords(input: { dnsZone: string; name?: string; type?: ScalewayDnsRecordType; id?: string; projectId?: string }): Effect.Effect<ScalewayDnsRecord[], ScalewayError>;
    updateRecords(input: { dnsZone: string; changes: ScalewayDnsRecordChange[]; return_all_records?: boolean; disallow_new_zone_creation?: boolean; projectId?: string }): Effect.Effect<ScalewayDnsRecord[], ScalewayError>;
  };
  registry: {
    createNamespace(input: {
      name: string;
      project_id: string;
      description?: string;
      is_public?: boolean;
    }): Effect.Effect<ScalewayRegistryNamespaceRecord, ScalewayError>;
    getNamespace(
      namespaceId: string,
    ): Effect.Effect<ScalewayRegistryNamespaceRecord, ScalewayError>;
    updateNamespace(
      namespaceId: string,
      input: {
        description?: string;
        is_public?: boolean;
      },
    ): Effect.Effect<ScalewayRegistryNamespaceRecord, ScalewayError>;
    deleteNamespace(namespaceId: string): Effect.Effect<void, ScalewayError>;
  };
  secretManager: {
    createSecret(
      input: Record<string, unknown>,
    ): Effect.Effect<ScalewaySecretRecord, ScalewayError>;
    getSecret(secretId: string): Effect.Effect<ScalewaySecretRecord, ScalewayError>;
    updateSecret(
      secretId: string,
      input: Record<string, unknown>,
    ): Effect.Effect<ScalewaySecretRecord, ScalewayError>;
    protectSecret(secretId: string): Effect.Effect<ScalewaySecretRecord, ScalewayError>;
    unprotectSecret(secretId: string): Effect.Effect<ScalewaySecretRecord, ScalewayError>;
    deleteSecret(secretId: string): Effect.Effect<void, ScalewayError>;
    createVersion(
      secretId: string,
      input: Record<string, unknown>,
    ): Effect.Effect<ScalewaySecretVersionRecord, ScalewayError>;
    getVersion(
      secretId: string,
      revision: string | number,
    ): Effect.Effect<ScalewaySecretVersionRecord, ScalewayError>;
  };
  rdb: {
    createInstance(input: { region: string } & Record<string, unknown>): Effect.Effect<ScalewayRdbInstanceRecord, ScalewayError>;
    getInstance(input: { region: string; instanceId: string }): Effect.Effect<ScalewayRdbInstanceRecord, ScalewayError>;
    updateInstance(input: { region: string; instanceId: string } & Record<string, unknown>): Effect.Effect<ScalewayRdbInstanceRecord, ScalewayError>;
    deleteInstance(input: { region: string; instanceId: string }): Effect.Effect<void, ScalewayError>;
  };
  objectStorage: {
    createBucket(input: {
      name: string;
      region: string;
      tags?: Record<string, string>;
      versioning?: boolean;
    }): Effect.Effect<ObjectStorageBucketRecord, ScalewayError>;
    getBucket(input: {
      name: string;
      region?: string;
    }): Effect.Effect<ObjectStorageBucketRecord, ScalewayError>;
    updateBucket(input: {
      name: string;
      region: string;
      tags?: Record<string, string>;
      versioning?: boolean;
    }): Effect.Effect<ObjectStorageBucketRecord, ScalewayError>;
    deleteBucket(input: { name: string; region: string }): Effect.Effect<void, ScalewayError>;
    getObject(input: {
      bucket: string;
      region: string;
      key: string;
    }): Effect.Effect<string | undefined, ScalewayError>;
    putObject(input: {
      bucket: string;
      region: string;
      key: string;
      body: string;
      contentType?: string;
    }): Effect.Effect<void, ScalewayError>;
    deleteObject(input: {
      bucket: string;
      region: string;
      key: string;
    }): Effect.Effect<void, ScalewayError>;
    listObjects(input: {
      bucket: string;
      region: string;
      prefix: string;
    }): Effect.Effect<readonly string[], ScalewayError>;
  };
  vpc: {
    createVpc(input: {
      name: string;
      project_id: string;
      tags?: string[];
    }): Effect.Effect<ScalewayVpcRecord, ScalewayError>;
    getVpc(vpcId: string): Effect.Effect<ScalewayVpcRecord, ScalewayError>;
    updateVpc(
      vpcId: string,
      input: { name?: string; tags?: string[] },
    ): Effect.Effect<ScalewayVpcRecord, ScalewayError>;
    enableVpcRouting(vpcId: string): Effect.Effect<ScalewayVpcRecord, ScalewayError>;
    enableVpcCustomRoutesPropagation(vpcId: string): Effect.Effect<ScalewayVpcRecord, ScalewayError>;
    deleteVpc(vpcId: string): Effect.Effect<void, ScalewayError>;
    createPrivateNetwork(input: {
      name: string;
      project_id: string;
      vpc_id?: string;
      tags?: string[];
      subnets?: string[];
      default_route_propagation_enabled?: boolean;
    }): Effect.Effect<ScalewayPrivateNetworkRecord, ScalewayError>;
    getPrivateNetwork(
      privateNetworkId: string,
    ): Effect.Effect<ScalewayPrivateNetworkRecord, ScalewayError>;
    updatePrivateNetwork(
      privateNetworkId: string,
      input: {
        name?: string;
        tags?: string[];
        default_route_propagation_enabled?: boolean;
      },
    ): Effect.Effect<ScalewayPrivateNetworkRecord, ScalewayError>;
    deletePrivateNetwork(privateNetworkId: string): Effect.Effect<void, ScalewayError>;
    addPrivateNetworkSubnet(
      privateNetworkId: string,
      subnet: string,
    ): Effect.Effect<ScalewayPrivateNetworkRecord, ScalewayError>;
    deletePrivateNetworkSubnet(
      privateNetworkId: string,
      subnet: string,
    ): Effect.Effect<ScalewayPrivateNetworkRecord, ScalewayError>;
    enablePrivateNetworkDhcp(
      privateNetworkId: string,
    ): Effect.Effect<ScalewayPrivateNetworkRecord, ScalewayError>;
    getAclRules(input: {
      vpcId: string;
      ipv6: boolean;
    }): Effect.Effect<ScalewayVpcAclRecord, ScalewayError>;
    setAclRules(input: {
      vpcId: string;
      ipv6: boolean;
      default_policy: string;
      rules: ScalewayVpcAclRuleRecord[];
    }): Effect.Effect<ScalewayVpcAclRecord, ScalewayError>;
    createRoute(input: {
      description?: string;
      tags?: string[];
      vpc_id: string;
      destination: string;
      nexthop_resource_id?: string;
      nexthop_private_network_id?: string;
      nexthop_vpc_connector_id?: string;
    }): Effect.Effect<ScalewayVpcRouteRecord, ScalewayError>;
    getRoute(routeId: string): Effect.Effect<ScalewayVpcRouteRecord, ScalewayError>;
    updateRoute(
      routeId: string,
      input: {
        description?: string | null;
        tags?: string[];
        destination?: string;
        nexthop_resource_id?: string | null;
        nexthop_private_network_id?: string | null;
        nexthop_vpc_connector_id?: string | null;
      },
    ): Effect.Effect<ScalewayVpcRouteRecord, ScalewayError>;
    deleteRoute(routeId: string): Effect.Effect<void, ScalewayError>;
    createVpcConnector(input: {
      name: string;
      tags?: string[];
      vpc_id: string;
      target_vpc_id: string;
    }): Effect.Effect<ScalewayVpcConnectorRecord, ScalewayError>;
    getVpcConnector(vpcConnectorId: string): Effect.Effect<ScalewayVpcConnectorRecord, ScalewayError>;
    updateVpcConnector(
      vpcConnectorId: string,
      input: { name?: string; tags?: string[] },
    ): Effect.Effect<ScalewayVpcConnectorRecord, ScalewayError>;
    deleteVpcConnector(vpcConnectorId: string): Effect.Effect<void, ScalewayError>;
  };
  instance: {
    createInstance(input: { zone: string } & Record<string, unknown>): Effect.Effect<ScalewayInstanceRecord, ScalewayError>;
    getInstance(input: { zone: string; serverId: string }): Effect.Effect<ScalewayInstanceRecord, ScalewayError>;
    updateInstance(input: { zone: string; serverId: string } & Record<string, unknown>): Effect.Effect<ScalewayInstanceRecord, ScalewayError>;
    deleteInstance(input: { zone: string; serverId: string }): Effect.Effect<void, ScalewayError>;
    instanceAction(input: { zone: string; serverId: string; action: string }): Effect.Effect<void, ScalewayError>;
    setInstanceUserData(input: { zone: string; serverId: string; key: string; value: string }): Effect.Effect<void, ScalewayError>;
    createSecurityGroup(input: {
      zone: string;
      name: string;
      project?: string;
      description?: string;
      tags?: string[];
      inbound_default_policy?: string;
      outbound_default_policy?: string;
      stateful?: boolean;
      project_default?: boolean;
    }): Effect.Effect<ScalewaySecurityGroupRecord, ScalewayError>;
    getSecurityGroup(input: { zone: string; securityGroupId: string }): Effect.Effect<ScalewaySecurityGroupRecord, ScalewayError>;
    updateSecurityGroup(input: {
      zone: string;
      securityGroupId: string;
      name?: string;
      description?: string | null;
      tags?: string[];
      inbound_default_policy?: string;
      outbound_default_policy?: string;
      stateful?: boolean;
      project_default?: boolean;
    }): Effect.Effect<ScalewaySecurityGroupRecord, ScalewayError>;
    deleteSecurityGroup(input: { zone: string; securityGroupId: string }): Effect.Effect<void, ScalewayError>;
    listSecurityGroupRules(input: { zone: string; securityGroupId: string }): Effect.Effect<ScalewaySecurityGroupRuleRecord[], ScalewayError>;
    setSecurityGroupRules(input: { zone: string; securityGroupId: string; rules: ScalewaySecurityGroupRuleRecord[] }): Effect.Effect<ScalewaySecurityGroupRuleRecord[], ScalewayError>;
    createFlexibleIp(input: { zone: string; project?: string; tags?: string[]; server?: string; type?: string }): Effect.Effect<ScalewayFlexibleIpRecord, ScalewayError>;
    getFlexibleIp(input: { zone: string; ip: string }): Effect.Effect<ScalewayFlexibleIpRecord, ScalewayError>;
    updateFlexibleIp(input: { zone: string; ip: string; reverse?: string | null; tags?: string[]; server?: string | null }): Effect.Effect<ScalewayFlexibleIpRecord, ScalewayError>;
    deleteFlexibleIp(input: { zone: string; ip: string }): Effect.Effect<void, ScalewayError>;
    createPrivateNic(input: { zone: string; serverId: string; private_network_id: string; tags?: string[]; ipam_ip_ids?: string[] }): Effect.Effect<ScalewayPrivateNicRecord, ScalewayError>;
    getPrivateNic(input: { zone: string; serverId: string; privateNicId: string }): Effect.Effect<ScalewayPrivateNicRecord, ScalewayError>;
    updatePrivateNic(input: { zone: string; serverId: string; privateNicId: string; tags?: string[] }): Effect.Effect<ScalewayPrivateNicRecord, ScalewayError>;
    deletePrivateNic(input: { zone: string; serverId: string; privateNicId: string }): Effect.Effect<void, ScalewayError>;
  };
  block: {
    deleteVolume(input: { zone: string; volumeId: string }): Effect.Effect<void, ScalewayError>;
  };
}

export const makeScalewayClients = Effect.gen(function* () {
  const credentials = yield* ScalewayCredentials;
  const { apiUrl, region, projectId } = credentials;
  const secretKey = Redacted.value(credentials.secretKey);
  const base = `/containers/v1/regions/${region}`;
  const registryBase = `/registry/v1/regions/${region}`;
  const secretManagerBase = `/secret-manager/v1beta1/regions/${region}`;
  const vpcBase = `/vpc/v2/regions/${region}`;
  const dnsBase = "/domain/v2beta1";

  const request = <T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${apiUrl}${path}`, {
          method,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Auth-Token": secretKey,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        const decoded = text.length === 0 ? undefined : JSON.parse(text);
        if (!response.ok) {
          const message =
            messageFromBody(decoded) ?? `Scaleway request failed with status ${response.status}`;
          throw scalewayError({
            operation: `${method} ${path}`,
            cause: new Error(message),
            statusCode: response.status,
            retryable: response.status >= 500 || response.status === 429,
          });
        }
        return decoded as T;
      },
      catch: (cause) =>
        cause instanceof Error && cause.name === "ScalewayError"
          ? (cause as ScalewayError)
          : scalewayError({ operation: `${method} ${path}`, cause }),
    });

  const objectStorage = makeObjectStorageClient(credentials.accessKey, secretKey, region);
  const query = (params: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) search.set(key, String(value));
    }
    const rendered = search.toString();
    return rendered ? `?${rendered}` : "";
  };

  return {
    region,
    projectId,
    account: {
      createProject: (input) =>
        request("POST", "/account/v3/projects", input).pipe(Effect.map(decodeProject)),
      getProject: (id) =>
        request("GET", `/account/v3/projects/${id}`).pipe(Effect.map(decodeProject)),
      updateProject: (id, input) =>
        request("PATCH", `/account/v3/projects/${id}`, input).pipe(Effect.map(decodeProject)),
      deleteProject: (id) => request<void>("DELETE", `/account/v3/projects/${id}`),
    },
    containers: {
      createNamespace: (input) =>
        request("POST", `${base}/namespaces`, input).pipe(Effect.map(decodeNamespace)),
      getNamespace: (id) =>
        request("GET", `${base}/namespaces/${id}`).pipe(Effect.map(decodeNamespace)),
      updateNamespace: (id, input) =>
        request("PATCH", `${base}/namespaces/${id}`, input).pipe(Effect.map(decodeNamespace)),
      deleteNamespace: (id) => request<void>("DELETE", `${base}/namespaces/${id}`),
      createContainer: (input) =>
        request("POST", `${base}/containers`, input).pipe(Effect.map(decodeContainer)),
      getContainer: (id) =>
        request("GET", `${base}/containers/${id}`).pipe(Effect.map(decodeContainer)),
      updateContainer: (id, input) =>
        request("PATCH", `${base}/containers/${id}`, input).pipe(Effect.map(decodeContainer)),
      deleteContainer: (id) => request<void>("DELETE", `${base}/containers/${id}`),
      createTrigger: (input) =>
        request("POST", `${base}/triggers`, input).pipe(Effect.map(decodeTrigger)),
      getTrigger: (id) => request("GET", `${base}/triggers/${id}`).pipe(Effect.map(decodeTrigger)),
      updateTrigger: (id, input) =>
        request("PATCH", `${base}/triggers/${id}`, input).pipe(Effect.map(decodeTrigger)),
      deleteTrigger: (id) => request<void>("DELETE", `${base}/triggers/${id}`),
      createDomain: (input) =>
        request("POST", `${base}/domains`, input).pipe(Effect.map(decodeDomain)),
      getDomain: (id) => request("GET", `${base}/domains/${id}`).pipe(Effect.map(decodeDomain)),
      deleteDomain: (id) => request<void>("DELETE", `${base}/domains/${id}`),
    },
    dns: {
      listZones: ({ domain, dnsZone, projectId }) =>
        request<{ dns_zones?: ScalewayDnsZoneRecord[] }>(
          "GET",
          `${dnsBase}/dns-zones${query({ domain, dns_zone: dnsZone, project_id: projectId })}`,
        ).pipe(Effect.map((response) => response.dns_zones ?? [])),
      createZone: (input) =>
        request("POST", `${dnsBase}/dns-zones`, input).pipe(Effect.map(decodeDnsZone)),
      updateZone: ({ dnsZone, ...input }) =>
        request("PATCH", `${dnsBase}/dns-zones/${encodeURIComponent(dnsZone)}`, input).pipe(
          Effect.map(decodeDnsZone),
        ),
      deleteZone: ({ dnsZone, projectId }) =>
        request<void>(
          "DELETE",
          `${dnsBase}/dns-zones/${encodeURIComponent(dnsZone)}${query({ project_id: projectId })}`,
        ),
      listRecords: ({ dnsZone, name, type, id, projectId }) =>
        request<{ records?: ScalewayDnsRecord[] }>(
          "GET",
          `${dnsBase}/dns-zones/${encodeURIComponent(dnsZone)}/records${query({ name, type, id, project_id: projectId })}`,
        ).pipe(Effect.map((response) => response.records ?? [])),
      updateRecords: ({ dnsZone, projectId, ...input }) =>
        request<{ records?: ScalewayDnsRecord[] }>(
          "PATCH",
          `${dnsBase}/dns-zones/${encodeURIComponent(dnsZone)}/records${query({ project_id: projectId })}`,
          input,
        ).pipe(Effect.map((response) => response.records ?? [])),
    },
    registry: {
      createNamespace: (input) =>
        request("POST", `${registryBase}/namespaces`, input).pipe(
          Effect.map(decodeRegistryNamespace),
        ),
      getNamespace: (id) =>
        request("GET", `${registryBase}/namespaces/${id}`).pipe(
          Effect.map(decodeRegistryNamespace),
        ),
      updateNamespace: (id, input) =>
        request("PATCH", `${registryBase}/namespaces/${id}`, input).pipe(
          Effect.map(decodeRegistryNamespace),
        ),
      deleteNamespace: (id) => request<void>("DELETE", `${registryBase}/namespaces/${id}`),
    },
    secretManager: {
      createSecret: (input) =>
        request("POST", `${secretManagerBase}/secrets`, input).pipe(Effect.map(decodeSecret)),
      getSecret: (id) =>
        request("GET", `${secretManagerBase}/secrets/${id}`).pipe(Effect.map(decodeSecret)),
      updateSecret: (id, input) =>
        request("PATCH", `${secretManagerBase}/secrets/${id}`, input).pipe(
          Effect.map(decodeSecret),
        ),
      protectSecret: (id) =>
        request("POST", `${secretManagerBase}/secrets/${id}/protect`, {}).pipe(
          Effect.map(decodeSecret),
        ),
      unprotectSecret: (id) =>
        request("POST", `${secretManagerBase}/secrets/${id}/unprotect`, {}).pipe(
          Effect.map(decodeSecret),
        ),
      deleteSecret: (id) => request<void>("DELETE", `${secretManagerBase}/secrets/${id}`),
      createVersion: (id, input) =>
        request("POST", `${secretManagerBase}/secrets/${id}/versions`, input).pipe(
          Effect.map(decodeSecretVersion),
        ),
      getVersion: (id, revision) =>
        request("GET", `${secretManagerBase}/secrets/${id}/versions/${revision}`).pipe(
          Effect.map(decodeSecretVersion),
        ),
    },
    rdb: {
      createInstance: ({ region, ...input }) =>
        request("POST", `/rdb/v1/regions/${region}/instances`, input).pipe(Effect.map(decodeRdbInstance)),
      getInstance: ({ region, instanceId }) =>
        request("GET", `/rdb/v1/regions/${region}/instances/${instanceId}`).pipe(Effect.map(decodeRdbInstance)),
      updateInstance: ({ region, instanceId, ...input }) =>
        request("PATCH", `/rdb/v1/regions/${region}/instances/${instanceId}`, input).pipe(Effect.map(decodeRdbInstance)),
      deleteInstance: ({ region, instanceId }) =>
        request<void>("DELETE", `/rdb/v1/regions/${region}/instances/${instanceId}`),
    },
    objectStorage,
    vpc: {
      createVpc: (input) =>
        request("POST", `${vpcBase}/vpcs`, input).pipe(Effect.map(decodeVpc)),
      getVpc: (id) => request("GET", `${vpcBase}/vpcs/${id}`).pipe(Effect.map(decodeVpc)),
      updateVpc: (id, input) =>
        request("PATCH", `${vpcBase}/vpcs/${id}`, input).pipe(Effect.map(decodeVpc)),
      enableVpcRouting: (id) =>
        request("POST", `${vpcBase}/vpcs/${id}/enable-routing`, {}).pipe(Effect.map(decodeVpc)),
      enableVpcCustomRoutesPropagation: (id) =>
        request("POST", `${vpcBase}/vpcs/${id}/enable-custom-routes-propagation`, {}).pipe(
          Effect.map(decodeVpc),
        ),
      deleteVpc: (id) => request<void>("DELETE", `${vpcBase}/vpcs/${id}`),
      createPrivateNetwork: (input) =>
        request("POST", `${vpcBase}/private-networks`, input).pipe(
          Effect.map(decodePrivateNetwork),
        ),
      getPrivateNetwork: (id) =>
        request("GET", `${vpcBase}/private-networks/${id}`).pipe(
          Effect.map(decodePrivateNetwork),
        ),
      updatePrivateNetwork: (id, input) =>
        request("PATCH", `${vpcBase}/private-networks/${id}`, input).pipe(
          Effect.map(decodePrivateNetwork),
        ),
      deletePrivateNetwork: (id) => request<void>("DELETE", `${vpcBase}/private-networks/${id}`),
      addPrivateNetworkSubnet: (id, subnet) =>
        Effect.gen(function* () {
          yield* request("POST", `${vpcBase}/private-networks/${id}/subnets`, {
            subnets: [subnet],
          });
          return yield* request("GET", `${vpcBase}/private-networks/${id}`).pipe(
            Effect.map(decodePrivateNetwork),
          );
        }),
      deletePrivateNetworkSubnet: (id, subnet) =>
        Effect.gen(function* () {
          yield* request("DELETE", `${vpcBase}/private-networks/${id}/subnets`, {
            subnets: [subnet],
          });
          return yield* request("GET", `${vpcBase}/private-networks/${id}`).pipe(
            Effect.map(decodePrivateNetwork),
          );
        }),
      enablePrivateNetworkDhcp: (id) =>
        request("POST", `${vpcBase}/private-networks/${id}/enable-dhcp`, {}).pipe(
          Effect.map(decodePrivateNetwork),
        ),
      getAclRules: ({ vpcId, ipv6 }) =>
        request("GET", `${vpcBase}/vpcs/${vpcId}/acl-rules?is_ipv6=${ipv6}`).pipe(
          Effect.map(decodeVpcAcl),
        ),
      setAclRules: ({ vpcId, ipv6, default_policy, rules }) =>
        request("PUT", `${vpcBase}/vpcs/${vpcId}/acl-rules?is_ipv6=${ipv6}`, {
          default_policy,
          rules,
        }).pipe(Effect.map(decodeVpcAcl)),
      createRoute: (input) =>
        request("POST", `${vpcBase}/routes`, input).pipe(Effect.map(decodeVpcRoute)),
      getRoute: (id) => request("GET", `${vpcBase}/routes/${id}`).pipe(Effect.map(decodeVpcRoute)),
      updateRoute: (id, input) =>
        request("PATCH", `${vpcBase}/routes/${id}`, input).pipe(Effect.map(decodeVpcRoute)),
      deleteRoute: (id) => request<void>("DELETE", `${vpcBase}/routes/${id}`),
      createVpcConnector: (input) =>
        request("POST", `${vpcBase}/vpc-connectors`, input).pipe(
          Effect.map(decodeVpcConnector),
        ),
      getVpcConnector: (id) =>
        request("GET", `${vpcBase}/vpc-connectors/${id}`).pipe(Effect.map(decodeVpcConnector)),
      updateVpcConnector: (id, input) =>
        request("PATCH", `${vpcBase}/vpc-connectors/${id}`, input).pipe(
          Effect.map(decodeVpcConnector),
        ),
      deleteVpcConnector: (id) => request<void>("DELETE", `${vpcBase}/vpc-connectors/${id}`),
    },
    instance: {
      createInstance: ({ zone, ...input }) =>
        request("POST", `/instance/v1/zones/${zone}/servers`, input).pipe(Effect.map(decodeInstance)),
      getInstance: ({ zone, serverId }) =>
        request("GET", `/instance/v1/zones/${zone}/servers/${serverId}`).pipe(Effect.map(decodeInstance)),
      updateInstance: ({ zone, serverId, ...input }) =>
        request("PATCH", `/instance/v1/zones/${zone}/servers/${serverId}`, input).pipe(Effect.map(decodeInstance)),
      deleteInstance: ({ zone, serverId }) => request<void>("DELETE", `/instance/v1/zones/${zone}/servers/${serverId}`),
      instanceAction: ({ zone, serverId, action }) =>
        request("POST", `/instance/v1/zones/${zone}/servers/${serverId}/action`, { action }).pipe(Effect.asVoid),
      setInstanceUserData: ({ zone, serverId, key, value }) =>
        Effect.tryPromise({
          try: async () => {
            const response = await fetch(`${apiUrl}/instance/v1/zones/${zone}/servers/${serverId}/user_data/${encodeURIComponent(key)}`, {
              method: "PATCH",
              headers: {
                Accept: "application/json",
                "Content-Type": "text/plain",
                "X-Auth-Token": secretKey,
              },
              body: value,
            });
            if (!response.ok) {
              const text = await response.text();
              let decoded: unknown;
              try {
                decoded = text.length === 0 ? undefined : JSON.parse(text);
              } catch {
                decoded = text;
              }
              throw scalewayError({
                operation: `PATCH /instance/v1/zones/${zone}/servers/${serverId}/user_data/${key}`,
                cause: new Error(messageFromBody(decoded) ?? `Scaleway request failed with status ${response.status}`),
                statusCode: response.status,
                retryable: response.status >= 500 || response.status === 429,
              });
            }
          },
          catch: (cause) =>
            cause instanceof Error && cause.name === "ScalewayError"
              ? (cause as ScalewayError)
              : scalewayError({ operation: `PATCH /instance/v1/zones/${zone}/servers/${serverId}/user_data/${key}`, cause }),
        }),
      createSecurityGroup: ({ zone, ...input }) =>
        request("POST", `/instance/v1/zones/${zone}/security_groups`, input).pipe(Effect.map(decodeSecurityGroup)),
      getSecurityGroup: ({ zone, securityGroupId }) =>
        request("GET", `/instance/v1/zones/${zone}/security_groups/${securityGroupId}`).pipe(Effect.map(decodeSecurityGroup)),
      updateSecurityGroup: ({ zone, securityGroupId, ...input }) =>
        request("PATCH", `/instance/v1/zones/${zone}/security_groups/${securityGroupId}`, input).pipe(Effect.map(decodeSecurityGroup)),
      deleteSecurityGroup: ({ zone, securityGroupId }) => request<void>("DELETE", `/instance/v1/zones/${zone}/security_groups/${securityGroupId}`),
      listSecurityGroupRules: ({ zone, securityGroupId }) =>
        request("GET", `/instance/v1/zones/${zone}/security_groups/${securityGroupId}/rules`).pipe(Effect.map(decodeSecurityGroupRules)),
      setSecurityGroupRules: ({ zone, securityGroupId, rules }) =>
        request("PUT", `/instance/v1/zones/${zone}/security_groups/${securityGroupId}/rules`, { rules }).pipe(Effect.map(decodeSecurityGroupRules)),
      createFlexibleIp: ({ zone, ...input }) =>
        request("POST", `/instance/v1/zones/${zone}/ips`, input).pipe(Effect.map(decodeFlexibleIp)),
      getFlexibleIp: ({ zone, ip }) =>
        request("GET", `/instance/v1/zones/${zone}/ips/${ip}`).pipe(Effect.map(decodeFlexibleIp)),
      updateFlexibleIp: ({ zone, ip, ...input }) =>
        request("PATCH", `/instance/v1/zones/${zone}/ips/${ip}`, input).pipe(Effect.map(decodeFlexibleIp)),
      deleteFlexibleIp: ({ zone, ip }) => request<void>("DELETE", `/instance/v1/zones/${zone}/ips/${ip}`),
      createPrivateNic: ({ zone, serverId, ...input }) =>
        request("POST", `/instance/v1/zones/${zone}/servers/${serverId}/private_nics`, input).pipe(Effect.map(decodePrivateNic)),
      getPrivateNic: ({ zone, serverId, privateNicId }) =>
        request("GET", `/instance/v1/zones/${zone}/servers/${serverId}/private_nics/${privateNicId}`).pipe(Effect.map(decodePrivateNic)),
      updatePrivateNic: ({ zone, serverId, privateNicId, ...input }) =>
        request("PATCH", `/instance/v1/zones/${zone}/servers/${serverId}/private_nics/${privateNicId}`, input).pipe(Effect.map(decodePrivateNic)),
      deletePrivateNic: ({ zone, serverId, privateNicId }) => request<void>("DELETE", `/instance/v1/zones/${zone}/servers/${serverId}/private_nics/${privateNicId}`),
    },
    block: {
      deleteVolume: ({ zone, volumeId }) => request<void>("DELETE", `/block/v1alpha1/zones/${zone}/volumes/${volumeId}`),
    },
  } satisfies ScalewayClients;
});

// @crap-ignore: factory contains many small request closures; score them separately.
function makeObjectStorageClient(
  accessKey: string | undefined,
  secretKey: string,
  defaultRegion: string,
) {
  const clients = new Map<string, AwsClient>();
  const getClient = (region: string) => {
    if (!accessKey) throw new Error("Missing SCW_ACCESS_KEY for Scaleway Object Storage");
    const existing = clients.get(region);
    if (existing) return existing;
    const client = new AwsClient({
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      service: "s3",
      region,
    });
    clients.set(region, client);
    return client;
  };

  const bucketEndpoint = (region: string) => `https://s3.${region}.scw.cloud`;
  const bucketVirtualHostEndpoint = (bucket: string, region: string) =>
    `https://${bucket}.s3.${region}.scw.cloud`;
  const bucketPath = (bucket: string, path: string) => `/${bucket}${path}`;
  const objectPath = (key: string) => `/${key.split("/").map(encodeURIComponent).join("/")}`;
  const request = (
    bucket: string,
    region: string,
    method: "GET" | "PUT" | "HEAD" | "DELETE",
    path: string,
    init?: { body?: string; headers?: Record<string, string> },
  ) =>
    Effect.tryPromise({
      try: () =>
        getClient(region).fetch(`${bucketEndpoint(region)}${bucketPath(bucket, path)}`, {
          method,
          ...(init?.headers ? { headers: init.headers } : {}),
          ...(init?.body ? { body: init.body } : {}),
        }),
      catch: (cause) =>
        scalewayError({ operation: `${method} Object Storage ${path}`, resource: bucket, cause }),
    });

  const ensureOk = (response: Response, method: string, path: string) =>
    response.ok
      ? Effect.succeed(response)
      : Effect.tryPromise({
          try: async () => {
            const body = await response.text();
            const message =
              body.match(/<Message>([^<]+)<\/Message>/)?.[1] ??
              `Object Storage request failed with status ${response.status}`;
            throw scalewayError({
              operation: `${method} Object Storage ${path}`,
              cause: new Error(message),
              statusCode: response.status,
              retryable: response.status >= 500 || response.status === 429,
            });
          },
          catch: (cause) =>
            cause instanceof ScalewayError
              ? cause
              : scalewayError({ operation: `${method} Object Storage ${path}`, cause }),
        });

  const headBucket = (
    bucket: string,
    region: string,
  ): Effect.Effect<ObjectStorageBucketRecord, ScalewayError> =>
    Effect.gen(function* () {
      const response = yield* request(bucket, region, "HEAD", "/");
      yield* ensureOk(response, "HEAD", "/");
      const bucketRegion = response.headers.get("x-amz-bucket-region") ?? region;
      const versioning = yield* getVersioning(bucket, bucketRegion);
      const tags = yield* getTagging(bucket, bucketRegion);
      return omitUndefined({
        name: bucket,
        region: bucketRegion,
        endpoint: bucketVirtualHostEndpoint(bucket, bucketRegion),
        tags,
        versioning,
      }) as ObjectStorageBucketRecord;
    });

  const getVersioning = (bucket: string, region: string) =>
    Effect.gen(function* () {
      const response = yield* request(bucket, region, "GET", "/?versioning");
      const ok = yield* ensureOk(response, "GET", "/?versioning");
      const body = yield* Effect.tryPromise({
        try: () => ok.text(),
        catch: (cause) =>
          scalewayError({ operation: "read bucket versioning", resource: bucket, cause }),
      });
      return body.includes("<Status>Enabled</Status>");
    });

  const getTagging = (bucket: string, region: string) =>
    Effect.gen(function* () {
      const response = yield* request(bucket, region, "GET", "/?tagging");
      const ok = yield* ensureOk(response, "GET", "/?tagging");
      const body = yield* Effect.tryPromise({
        try: () => ok.text(),
        catch: (cause) => scalewayError({ operation: "read bucket tags", resource: bucket, cause }),
      });
      const matches = [
        ...body.matchAll(/<Tag>\s*<Key>([^<]+)<\/Key>\s*<Value>([^<]*)<\/Value>\s*<\/Tag>/g),
      ];
      return matches.length === 0
        ? undefined
        : Object.fromEntries(
            matches.map(([, key, value]) => [unescapeXml(key), unescapeXml(value)]),
          );
    }).pipe(
      Effect.catchIf(
        (error) =>
          isNotFound(error) ||
          (error instanceof ScalewayError &&
            (error.message.includes("NoSuchTagSet") || error.message.includes("NoSuchTagging"))),
        () => Effect.succeed(undefined),
      ),
    );

  const putVersioning = (bucket: string, region: string, enabled: boolean | undefined) =>
    enabled === undefined
      ? Effect.void
      : Effect.gen(function* () {
          const response = yield* request(bucket, region, "PUT", "/?versioning", {
            body: xml(
              `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${enabled ? "Enabled" : "Suspended"}</Status></VersioningConfiguration>`,
            ),
            headers: { "content-type": "application/xml" },
          });
          yield* ensureOk(response, "PUT", "/?versioning");
        });

  const putTags = (bucket: string, region: string, tags: Record<string, string> | undefined) =>
    tags === undefined
      ? Effect.void
      : Object.keys(tags).length === 0
        ? Effect.gen(function* () {
            const response = yield* request(bucket, region, "DELETE", "/?tagging");
            yield* ensureOk(response, "DELETE", "/?tagging");
          }).pipe(Effect.catchIf(isNotFound, () => Effect.void))
        : Effect.gen(function* () {
            const body = xml(
              `<Tagging><TagSet>${Object.entries(tags)
                .map(
                  ([key, value]) =>
                    `<Tag><Key>${escapeXml(key)}</Key><Value>${escapeXml(value)}</Value></Tag>`,
                )
                .join("")}</TagSet></Tagging>`,
            );
            const response = yield* request(bucket, region, "PUT", "/?tagging", {
              body,
              headers: { "content-type": "application/xml" },
            });
            yield* ensureOk(response, "PUT", "/?tagging");
          });

  const objectKeysFromList = (body: string) =>
    [...body.matchAll(/<Key>([^<]*)<\/Key>/g)].map(([, key]) => unescapeXml(key));

  return {
    createBucket: ({
      name,
      region,
      tags,
      versioning,
    }: {
      name: string;
      region: string;
      tags?: Record<string, string>;
      versioning?: boolean;
    }) =>
      Effect.gen(function* () {
        const response = yield* request(name, region, "PUT", "/", {
          body: xml(
            `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${escapeXml(region)}</LocationConstraint></CreateBucketConfiguration>`,
          ),
          headers: { "content-type": "application/xml" },
        });
        yield* ensureOk(response, "PUT", "/");
        yield* putVersioning(name, region, versioning);
        yield* putTags(name, region, tags);
        return yield* headBucket(name, region);
      }),
    getBucket: ({ name, region }: { name: string; region?: string }) =>
      headBucket(name, region ?? defaultRegion),
    updateBucket: ({
      name,
      region,
      tags,
      versioning,
    }: {
      name: string;
      region: string;
      tags?: Record<string, string>;
      versioning?: boolean;
    }) =>
      Effect.gen(function* () {
        yield* putVersioning(name, region, versioning);
        yield* putTags(name, region, tags);
        return yield* headBucket(name, region);
      }),
    deleteBucket: ({ name, region }: { name: string; region: string }) =>
      Effect.gen(function* () {
        const response = yield* request(name, region, "DELETE", "/");
        yield* ensureOk(response, "DELETE", "/");
      }),
    getObject: ({ bucket, region, key }: { bucket: string; region: string; key: string }) =>
      Effect.gen(function* () {
        const path = objectPath(key);
        const response = yield* request(bucket, region, "GET", path);
        if (response.status === 404) return undefined;
        const ok = yield* ensureOk(response, "GET", path);
        return yield* Effect.tryPromise({
          try: () => ok.text(),
          catch: (cause) => scalewayError({ operation: "read Object Storage object", resource: key, cause }),
        });
      }),
    putObject: ({
      bucket,
      region,
      key,
      body,
      contentType,
    }: {
      bucket: string;
      region: string;
      key: string;
      body: string;
      contentType?: string;
    }) =>
      Effect.gen(function* () {
        const path = objectPath(key);
        const response = yield* request(bucket, region, "PUT", path, {
          body,
          headers: contentType ? { "content-type": contentType } : undefined,
        });
        yield* ensureOk(response, "PUT", path);
      }),
    deleteObject: ({ bucket, region, key }: { bucket: string; region: string; key: string }) =>
      Effect.gen(function* () {
        const path = objectPath(key);
        const response = yield* request(bucket, region, "DELETE", path);
        if (response.status === 404) return;
        yield* ensureOk(response, "DELETE", path);
      }),
    listObjects: ({ bucket, region, prefix }: { bucket: string; region: string; prefix: string }) =>
      Effect.gen(function* () {
        const keys: string[] = [];
        let continuation: string | undefined;
        do {
          const query = new URLSearchParams({ "list-type": "2", prefix });
          if (continuation) query.set("continuation-token", continuation);
          const path = `/?${query.toString()}`;
          const response = yield* request(bucket, region, "GET", path);
          const ok = yield* ensureOk(response, "GET", path);
          const body = yield* Effect.tryPromise({
            try: () => ok.text(),
            catch: (cause) => scalewayError({ operation: "list Object Storage objects", resource: bucket, cause }),
          });
          keys.push(...objectKeysFromList(body));
          continuation = body.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1];
        } while (continuation);
        return keys;
      }),
  };
}

const xml = (value: string) => `<?xml version="1.0" encoding="UTF-8"?>${value}`;
const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
const unescapeXml = (value: string) =>
  value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
const validationDetails = (details: unknown) =>
  Array.isArray(details)
    ? details
        .map((detail) => {
          const record = detail as Record<string, unknown>;
          return [record.argument_name, record.help_message].filter((value) => typeof value === "string" && value.length > 0).join(": ");
        })
        .filter((detail) => detail.length > 0)
    : [];
const messageFromBody = (body: unknown) => {
  if (typeof body !== "object" || body === null || !("message" in body)) return undefined;
  const message = String(body.message);
  const details = validationDetails((body as Record<string, unknown>).details);
  return details.length === 0 ? message : `${message}: ${details.join("; ")}`;
};
// The Containers v1 API returns resource objects at the top level (no envelope key).
const decodeNamespace = (value: unknown) => value as ScalewayNamespaceRecord;
const decodeContainer = (value: unknown) => value as ScalewayContainerRecord;
const decodeTrigger = (value: unknown) => value as ScalewayTriggerRecord;
const decodeDomain = (value: unknown) => value as ScalewayDomainRecord;
const decodeProject = (value: unknown) => envelope<ScalewayProjectRecord>(value, "project");
const decodeDnsZone = (value: unknown) => value as ScalewayDnsZoneRecord;
const decodeRegistryNamespace = (value: unknown) => value as ScalewayRegistryNamespaceRecord;
const decodeSecret = (value: unknown) => value as ScalewaySecretRecord;
const decodeSecretVersion = (value: unknown) => value as ScalewaySecretVersionRecord;
const decodeRdbInstance = (value: unknown) =>
  typeof value === "object" && value !== null && "instance" in value
    ? envelope<ScalewayRdbInstanceRecord>(value, "instance")
    : value as ScalewayRdbInstanceRecord;
const envelope = <T>(value: unknown, key: string) =>
  typeof value === "object" && value !== null && key in value
    ? ((value as Record<string, unknown>)[key] as T)
    : (value as T);
const decodeVpc = (value: unknown) => envelope<ScalewayVpcRecord>(value, "vpc");
const decodePrivateNetwork = (value: unknown) => {
  const record = envelope<
    Omit<ScalewayPrivateNetworkRecord, "subnets"> & { subnets?: Array<string | { subnet: string }> }
  >(value, "private_network");
  return {
    ...record,
    subnets: record.subnets?.map((subnet) => (typeof subnet === "string" ? subnet : subnet.subnet)),
  } as ScalewayPrivateNetworkRecord;
};
const decodeVpcAcl = (value: unknown): ScalewayVpcAclRecord => {
  const envelopeValue = envelope<ScalewayVpcAclRecord>(value, "acl_rules");
  return {
    default_policy: envelopeValue.default_policy,
    rules: envelopeValue.rules ?? [],
  };
};
const decodeVpcRoute = (value: unknown) => envelope<ScalewayVpcRouteRecord>(value, "route");
const decodeVpcConnector = (value: unknown) =>
  envelope<ScalewayVpcConnectorRecord>(value, "vpc_connector");
const decodeInstance = (value: unknown) => envelope<ScalewayInstanceRecord>(value, "server");
const decodeSecurityGroup = (value: unknown) => envelope<ScalewaySecurityGroupRecord>(value, "security_group");
const decodeSecurityGroupRules = (value: unknown) => envelope<ScalewaySecurityGroupRuleRecord[]>(value, "rules") ?? [];
const decodeFlexibleIp = (value: unknown) => envelope<ScalewayFlexibleIpRecord>(value, "ip");
const decodePrivateNic = (value: unknown) => envelope<ScalewayPrivateNicRecord>(value, "private_nic");
