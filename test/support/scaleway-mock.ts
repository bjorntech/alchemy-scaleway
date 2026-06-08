// In-memory Scaleway simulator installed over `globalThis.fetch`.
//
// It serves both the Containers REST API (`api.scaleway.com`) and the
// S3-compatible Object Storage API (`s3.<region>.scw.cloud`, reached through
// aws4fetch). This lets the real provider lifecycle and `Clients.ts` run
// end-to-end with only the network boundary faked.

export interface MockCall {
  method: string;
  url: string;
  headers: Headers;
  body: string;
}

export interface ScalewayMock {
  readonly calls: ReadonlyArray<MockCall>;
  restore(): void;
  /** Enable provider-like transient create/delete states for focused lifecycle tests. */
  enableAsyncLifecycle(): void;
  addFlexibleIp(id: string): void;
  setFlexibleIpTags(id: string, tags: string[]): void;
  /** Drop a record so the next `read`/`get` behaves like a 404. */
  removeContainer(id: string): void;
  removeVpc(id: string): void;
  removePrivateNetwork(id: string): void;
  removeRoute(id: string): void;
  removeVpcConnector(id: string): void;
  removeServer(id: string): void;
  removeSecurityGroup(id: string): void;
  removeFlexibleIp(id: string): void;
  removePrivateNic(serverId: string, id: string): void;
  removeBucket(name: string): void;
  /** Seed a bucket that Alchemy does not own (no `alchemy:logical-id` tag). */
  seedBucket(name: string, region: string, tags?: Record<string, string>): void;
  /** Seed an existing DNS zone, such as an apex zone registered outside Alchemy. */
  seedDnsZone(dnsZone: string, projectId?: string): void;
  /** Make the next created custom domains enter Scaleway's deployment error state. */
  failNextDomainDeploys(count: number): void;
  /** Make the next matching Containers request fail with a status + message. */
  failNext(urlFragment: string, status: number, message: string): void;
}

interface BucketState {
  region: string;
  versioning: boolean;
  tags: Record<string, string>;
  objects: Map<string, string>;
}

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const pageOf = <T>(items: T[], params: URLSearchParams) => {
  const page = Number(params.get("page") ?? "1");
  const pageSize = Number(params.get("page_size") ?? String(items.length || 1));
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    total_count: items.length,
  };
};

const noContent = () => new Response("", { status: 204 });

const xmlError = (code: string, message: string, status: number) =>
  new Response(
    `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
    {
      status,
      headers: { "content-type": "application/xml" },
    },
  );

export function installScalewayMock(): ScalewayMock {
  const original = globalThis.fetch;
  const calls: MockCall[] = [];

  const namespaces = new Map<string, Record<string, unknown>>();
  const registryNamespaces = new Map<string, Record<string, unknown>>();
  const secrets = new Map<string, Record<string, unknown>>();
  const secretVersions = new Map<string, Array<Record<string, unknown>>>();
  const databaseInstances = new Map<string, Record<string, unknown>>();
  const containers = new Map<string, Record<string, unknown>>();
  const triggers = new Map<string, Record<string, unknown>>();
  const domains = new Map<string, Record<string, unknown>>();
  const dnsZones = new Map<string, Record<string, unknown>>();
  const dnsRecords = new Map<string, Array<Record<string, unknown>>>();
  const projects = new Map<string, Record<string, unknown>>();
  const buckets = new Map<string, BucketState>();
  const vpcs = new Map<string, Record<string, unknown>>();
  const privateNetworks = new Map<string, Record<string, unknown>>();
  const aclRules = new Map<string, Record<string, unknown>>();
  const routes = new Map<string, Record<string, unknown>>();
  const vpcConnectors = new Map<string, Record<string, unknown>>();
  const servers = new Map<string, Record<string, unknown>>();
  const serverUserData = new Map<string, Map<string, string>>();
  const volumes = new Map<string, Record<string, unknown>>();
  const securityGroups = new Map<string, Record<string, unknown>>();
  const securityGroupRules = new Map<string, Array<Record<string, unknown>>>();
  const flexibleIps = new Map<string, Record<string, unknown>>();
  const privateNics = new Map<string, Record<string, unknown>>();
  let counter = 0;
  let asyncLifecycle = false;
  let domainDeployErrorsRemaining = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;
  const forcedErrors: Array<{ fragment: string; status: number; message: string }> = [];

  const containersHandler = (method: string, pathname: string, body: unknown): Response => {
    // The v1 API returns resource objects flat (no envelope), e.g. {"id": ..., "name": ...}.
    const segments = pathname.split("/").filter(Boolean); // [containers, v1, regions, fr-par, <kind>, <id?>]
    const kind = segments[4];
    const id = segments[5];
    const input = (body ?? {}) as Record<string, unknown>;

    if (kind === "namespaces") {
      if (method === "POST") {
        const record = { id: nextId("ns"), region: "fr-par", status: "ready", ...input };
        namespaces.set(record.id as string, record);
        return json(record);
      }
      const existing = namespaces.get(id);
      if (!existing) return json({ message: "namespace not found" }, 404);
      if (method === "GET") return json(existing);
      if (method === "PATCH") {
        const updated = { ...existing, ...input };
        namespaces.set(id, updated);
        return json(updated);
      }
      if (method === "DELETE") {
        namespaces.delete(id);
        return noContent();
      }
    }

    if (kind === "containers") {
      // v1 has no separate deploy endpoint; Create/Update auto-deploy.
      if (method === "POST") {
        const record: Record<string, unknown> = {
          id: nextId("ctr"),
          region: "fr-par",
          status: "ready",
          public_endpoint: `https://${nextId("ep")}.functions.fnc.fr-par.scw.cloud`,
          project_id: "proj-test",
          ...input,
        };
        containers.set(record.id as string, record);
        return json(record);
      }
      const existing = containers.get(id);
      if (!existing) return json({ message: "container not found" }, 404);
      if (method === "GET") return json(existing);
      if (method === "PATCH") {
        const updated = { ...existing, ...input, status: "ready" };
        containers.set(id, updated);
        return json(updated);
      }
      if (method === "DELETE") {
        containers.delete(id);
        return noContent();
      }
    }

    if (kind === "triggers") {
      const configKeys = ["cron_config", "sqs_config", "nats_config", "destination_config"];
      const sourceTypeOf = (cfg: Record<string, unknown>) =>
        cfg.cron_config
          ? "cron"
          : cfg.sqs_config
            ? "sqs"
            : cfg.nats_config
              ? "nats"
              : "unknown_source_type";
      // The API persists but never returns write-only secrets.
      const stripSecrets = (rec: Record<string, unknown>) => {
        const out = { ...rec };
        for (const [key, secret] of [
          ["sqs_config", "secret_access_key"],
          ["nats_config", "credentials_file_content"],
        ] as const) {
          if (out[key]) {
            const { [secret]: _omit, ...rest } = out[key] as Record<string, unknown>;
            out[key] = rest;
          }
        }
        return out;
      };
      if (method === "POST") {
        const record = stripSecrets({
          id: nextId("trigger"),
          status: "ready",
          source_type: sourceTypeOf(input),
          ...input,
        });
        triggers.set(record.id as string, record);
        return json(record);
      }
      const existing = triggers.get(id);
      if (!existing) return json({ message: "trigger not found" }, 404);
      if (method === "GET") return json(existing);
      if (method === "PATCH") {
        const updated: Record<string, unknown> = { ...existing, ...input, status: "ready" };
        // config blocks are patched field-by-field, not wholesale-replaced.
        for (const key of configKeys) {
          if (input[key]) {
            updated[key] = {
              ...((existing[key] as Record<string, unknown>) ?? {}),
              ...(input[key] as Record<string, unknown>),
            };
          }
        }
        const result = stripSecrets(updated);
        triggers.set(id, result);
        return json(result);
      }
      if (method === "DELETE") {
        triggers.delete(id);
        return noContent();
      }
    }

    if (kind === "domains") {
      if (method === "POST") {
        const status = domainDeployErrorsRemaining > 0 ? "error" : "ready";
        if (domainDeployErrorsRemaining > 0) domainDeployErrorsRemaining--;
        const record = {
          id: nextId("dom"),
          status,
          error_message: status === "error"
            ? "An internal error occurred while deploying the domain. Please retry or contact support if the problem persists."
            : undefined,
          ...input,
        };
        domains.set(record.id as string, record);
        return json(record);
      }
      const existing = domains.get(id);
      if (!existing) return json({ message: "domain not found" }, 404);
      if (method === "GET") return json(existing);
      if (method === "DELETE") {
        domains.delete(id);
        return noContent();
      }
    }

    return json({ message: `unhandled containers request ${method} ${pathname}` }, 400);
  };

  const zoneNameOf = (zone: Record<string, unknown>) => {
    const subdomain = zone.subdomain as string | undefined;
    return subdomain ? `${subdomain}.${zone.domain}` : zone.domain as string;
  };
  const zoneKeyOf = (zone: Record<string, unknown>) => `${zone.project_id ?? ""}:${zoneNameOf(zone)}`;
  const zoneRecordOf = (dnsZone: string, projectId = "proj-test") => {
    return {
      ns: ["ns0.dom.scw.cloud", "ns1.dom.scw.cloud"],
      ns_default: ["ns0.dom.scw.cloud", "ns1.dom.scw.cloud"],
      ns_master: [],
      status: "active",
      updated_at: "2026-06-06T00:00:00Z",
      domain: dnsZone,
      subdomain: "",
      project_id: projectId,
    };
  };
  const zoneKey = (dnsZone: string, projectId: string | null) =>
    projectId === null
      ? [...dnsZones.entries()].find(([, zone]) => zoneNameOf(zone) === dnsZone)?.[0]
      : `${projectId}:${dnsZone}`;

  const dnsHandler = (method: string, pathname: string, search: string, body: unknown): Response => {
    const segments = pathname.split("/").filter(Boolean); // [domain, v2beta1, dns-zones, zone?, records?]
    const kind = segments[2];
    const id = segments[3] ? decodeURIComponent(segments[3]) : undefined;
    const nested = segments[4];
    const input = (body ?? {}) as Record<string, unknown>;
    const params = new URLSearchParams(search);

    if (kind !== "dns-zones") return json({ message: `unhandled dns request ${method} ${pathname}` }, 400);

    if (!id) {
      if (method === "GET") {
        const dnsZone = params.get("dns_zone");
        const projectId = params.get("project_id");
        const zones = [...dnsZones.values()].filter((zone) => {
          if (dnsZone && zoneNameOf(zone) !== dnsZone) return false;
          if (projectId && zone.project_id !== projectId) return false;
          return true;
        });
        return json({ total_count: zones.length, dns_zones: zones });
      }
      if (method === "POST") {
        if (typeof input.subdomain !== "string" || input.subdomain.length === 0) {
          return json({ message: "invalid argument: subdomain is required" }, 400);
        }
        const record: Record<string, unknown> = {
          ns: ["ns0.dom.scw.cloud", "ns1.dom.scw.cloud"],
          ns_default: ["ns0.dom.scw.cloud", "ns1.dom.scw.cloud"],
          ns_master: [],
          status: "active",
          updated_at: "2026-06-06T00:00:00Z",
          ...input,
        };
        dnsZones.set(zoneKeyOf(record), record);
        return json(record);
      }
    }

    const currentZoneKey = id ? zoneKey(id, params.get("project_id")) : undefined;
    const zone = currentZoneKey ? dnsZones.get(currentZoneKey) : undefined;
    if (!zone) return json({ message: "dns zone not found" }, 404);

    if (!nested) {
      if (method === "DELETE") {
        dnsZones.delete(currentZoneKey as string);
        dnsRecords.delete(currentZoneKey as string);
        return json({});
      }
      if (method === "PATCH") {
        const nextName = input.new_dns_zone as string;
        const [subdomain, ...domainParts] = nextName.split(".");
        const updated = domainParts.length > 1
          ? { ...zone, domain: domainParts.join("."), subdomain }
          : { ...zone, domain: nextName, subdomain: "" };
        dnsZones.delete(currentZoneKey as string);
        dnsZones.set(zoneKeyOf(updated), updated);
        return json(updated);
      }
    }

    if (nested === "records") {
      const records = dnsRecords.get(currentZoneKey as string) ?? [];
      if (method === "GET") {
        const name = params.get("name");
        const type = params.get("type");
        const recordId = params.get("id");
        const found = records.filter((record) => {
          if (name !== null && record.name !== name) return false;
          if (type && record.type !== type) return false;
          if (recordId && record.id !== recordId) return false;
          return true;
        });
        return json({ total_count: found.length, records: found });
      }
      if (method === "PATCH") {
        let next = [...records];
        for (const change of (input.changes as Array<Record<string, unknown>>) ?? []) {
          if (change.clear) next = [];
          const set = change.set as { id_fields?: { name?: string; type?: string }; records?: Array<Record<string, unknown>> } | undefined;
          if (set) {
            next = next.filter((record) => record.name !== set.id_fields?.name || record.type !== set.id_fields?.type);
            next.push(...(set.records ?? []).map((record) => ({ id: nextId("dnsrec"), ttl: 300, priority: 0, ...record })));
          }
          const add = change.add as { records?: Array<Record<string, unknown>> } | undefined;
          if (add) next.push(...(add.records ?? []).map((record) => ({ id: nextId("dnsrec"), ttl: 300, priority: 0, ...record })));
          const del = change.delete as { id?: string; id_fields?: { name?: string; type?: string; data?: string; ttl?: number } } | undefined;
          if (del) {
            next = next.filter((record) => {
              if (del.id) return record.id !== del.id;
              const fields = del.id_fields ?? {};
              if (fields.name !== undefined && record.name !== fields.name) return true;
              if (fields.type !== undefined && record.type !== fields.type) return true;
              if (fields.data !== undefined && record.data !== fields.data) return true;
              if (fields.ttl !== undefined && record.ttl !== fields.ttl) return true;
              return false;
            });
          }
        }
        dnsRecords.set(currentZoneKey as string, next);
        return json({ records: input.return_all_records ? next : next });
      }
    }

    return json({ message: `unhandled dns request ${method} ${pathname}` }, 400);
  };

  const accountHandler = (method: string, pathname: string, search: string, body: unknown): Response => {
    const segments = pathname.split("/").filter(Boolean); // [account, v3, projects, id?]
    const kind = segments[2];
    const id = segments[3];
    const input = (body ?? {}) as Record<string, unknown>;
    const params = new URLSearchParams(search);

    if (kind === "projects") {
      if (!id && method === "GET") {
        const organizationId = params.get("organization_id") ?? undefined;
        const matching = [...projects.values()].filter((project) => !organizationId || project.organization_id === organizationId);
        const page = pageOf(matching, params);
        return json({ projects: page.items, total_count: page.total_count });
      }
      if (method === "POST") {
        const now = "2026-06-06T00:00:00.000000Z";
        const record = { id: nextId("project"), created_at: now, updated_at: now, ...input };
        projects.set(record.id as string, record);
        return json(record);
      }
      const existing = projects.get(id);
      if (!existing) return json({ message: "project not found" }, 404);
      if (method === "GET") return json(existing);
      if (method === "PATCH") {
        const updated = { ...existing, ...input, updated_at: "2026-06-06T00:00:01.000000Z" };
        projects.set(id, updated);
        return json(updated);
      }
      if (method === "DELETE") {
        projects.delete(id);
        return noContent();
      }
    }

    return json({ message: `unhandled account request ${method} ${pathname}` }, 400);
  };

  const registryHandler = (method: string, pathname: string, body: unknown): Response => {
    const segments = pathname.split("/").filter(Boolean); // [registry, v1, regions, fr-par, namespaces, id?]
    const kind = segments[4];
    const id = segments[5];
    const input = (body ?? {}) as Record<string, unknown>;

    if (kind === "namespaces") {
      if (method === "POST") {
        const record: Record<string, unknown> = {
          id: nextId("regns"),
          region: "fr-par",
          status: "ready",
          endpoint: `rg.fr-par.scw.cloud/${input.name}`,
          ...input,
        };
        registryNamespaces.set(record.id as string, record);
        return json(record);
      }
      const existing = registryNamespaces.get(id);
      if (!existing) return json({ message: "registry namespace not found" }, 404);
      if (method === "GET") return json(existing);
      if (method === "PATCH") {
        const updated = { ...existing, ...input };
        registryNamespaces.set(id, updated);
        return json(updated);
      }
      if (method === "DELETE") {
        registryNamespaces.delete(id);
        return noContent();
      }
    }

    return json({ message: `unhandled registry request ${method} ${pathname}` }, 400);
  };

  const secretManagerHandler = (method: string, pathname: string, body: unknown): Response => {
    const segments = pathname.split("/").filter(Boolean);
    const kind = segments[4];
    const secretId = segments[5];
    const subresource = segments[6];
    const revision = segments[7];
    const action = segments[8] ?? segments[6];
    const input = (body ?? {}) as Record<string, unknown>;

    if (kind === "secrets" && !secretId && method === "POST") {
      const record = {
        id: nextId("secret"),
        region: "fr-par",
        status: "ready",
        tags: [],
        version_count: 0,
        type: "opaque",
        path: "/",
        protected: false,
        ...input,
      };
      secrets.set(record.id as string, record);
      secretVersions.set(record.id as string, []);
      return json(record);
    }

    const existing = secrets.get(secretId);
    if (!existing) return json({ message: "secret not found" }, 404);

    if (kind === "secrets" && !subresource) {
      if (method === "GET") return json(existing);
      if (method === "PATCH") {
        const updated = { ...existing, ...input };
        secrets.set(secretId, updated);
        return json(updated);
      }
      if (method === "DELETE") {
        secrets.delete(secretId);
        secretVersions.delete(secretId);
        return noContent();
      }
    }

    if (kind === "secrets" && action === "protect" && method === "POST") {
      const updated = { ...existing, protected: true };
      secrets.set(secretId, updated);
      return json(updated);
    }
    if (kind === "secrets" && action === "unprotect" && method === "POST") {
      const updated = { ...existing, protected: false };
      secrets.set(secretId, updated);
      return json(updated);
    }

    if (kind === "secrets" && subresource === "versions") {
      const versions = secretVersions.get(secretId) ?? [];
      if (!revision && method === "POST") {
        const version = {
          revision: versions.length + 1,
          secret_id: secretId,
          status: "enabled",
          latest: true,
          region: "fr-par",
          description: input.description,
        };
        versions.forEach((item) => (item.latest = false));
        versions.push(version);
        secretVersions.set(secretId, versions);
        secrets.set(secretId, { ...existing, version_count: versions.length });
        return json(version);
      }
      if (method === "GET") {
        const version = revision === "latest" ? versions.at(-1) : versions[Number(revision) - 1];
        if (!version) return json({ message: "secret version not found" }, 404);
        return json(version);
      }
    }

    return json({ message: `unhandled secret manager request ${method} ${pathname}` }, 400);
  };

  const rdbHandler = (method: string, pathname: string, search: string, body: unknown): Response => {
    const segments = pathname.split("/").filter(Boolean);
    const kind = segments[4];
    const id = segments[5];
    const input = (body ?? {}) as Record<string, unknown>;
    const params = new URLSearchParams(search);

    const updatedRecord = (existing: Record<string, unknown>) => {
      const backupSchedule = existing.backup_schedule as Record<string, unknown> | undefined;
      return {
        ...existing,
        name: input.name ?? existing.name,
        tags: input.tags ?? existing.tags,
        backup_same_region: input.backup_same_region ?? existing.backup_same_region,
        backup_schedule: {
          ...(backupSchedule ?? {}),
          frequency: input.backup_schedule_frequency ?? backupSchedule?.frequency,
          retention: input.backup_schedule_retention ?? backupSchedule?.retention,
          disabled: input.is_backup_schedule_disabled ?? backupSchedule?.disabled,
        },
        updated_at: "2026-06-06T00:00:01.000000Z",
      };
    };

    if (kind === "instances" && !id && method === "GET") {
      const projectId = params.get("project_id") ?? undefined;
      const name = params.get("name") ?? undefined;
      const matching = [...databaseInstances.values()].filter((instance) =>
        (!projectId || instance.project_id === projectId) && (!name || instance.name === name)
      );
      const page = pageOf(matching, params);
      return json({ instances: page.items, total_count: page.total_count });
    }

    if (kind === "instances" && !id && method === "POST") {
      const hostname = `db-${counter + 1}.rdb.fr-par.scw.cloud`;
      const endpoint = { ip: `198.51.100.${counter + 1}`, port: 5432, hostname };
      const record = {
        id: nextId("rdb"),
        region: "fr-par",
        status: asyncLifecycle ? "initializing" : "ready",
        __readyReads: 0,
        endpoint,
        endpoints: [endpoint],
        tags: [],
        is_ha_cluster: false,
        volume: { type: input.volume_type ?? "lssd", size: input.volume_size ?? 0 },
        backup_schedule: { disabled: input.disable_backup ?? false, frequency: 24, retention: 7 },
        created_at: "2026-06-06T00:00:00.000000Z",
        ...input,
      };
      databaseInstances.set(record.id as string, record);
      return json(record);
    }

    if (kind === "instances" && id) {
      const existing = databaseInstances.get(id);
      if (!existing) return json({ message: "database instance not found" }, 404);
      if (method === "GET") {
        if (asyncLifecycle && existing.status === "initializing") {
          const readyReads = Number(existing.__readyReads ?? 0);
          if (readyReads > 0) {
            const updated = { ...existing, __readyReads: readyReads - 1 };
            databaseInstances.set(id, updated);
            return json(updated);
          }
          const updated = { ...existing, status: "ready", __readyReads: 0 };
          databaseInstances.set(id, updated);
          return json(updated);
        }
        if (asyncLifecycle && existing.status === "deleting") {
          const deleteReads = Number(existing.__deleteReads ?? 0);
          if (deleteReads > 0) {
            const updated = { ...existing, __deleteReads: deleteReads - 1 };
            databaseInstances.set(id, updated);
            return json(updated);
          }
          databaseInstances.delete(id);
          return json({ message: "database instance not found" }, 404);
        }
        return json(existing);
      }
      if (method === "PATCH") {
        if (asyncLifecycle && existing.status === "initializing") {
          return json({ message: "resource is in a transient state", type: "transient_state" }, 409);
        }
        const updated = updatedRecord(existing);
        databaseInstances.set(id, updated);
        return json(updated);
      }
      if (method === "DELETE") {
        if (asyncLifecycle && existing.status === "initializing") {
          return json({ message: "resource is in a transient state", type: "transient_state" }, 409);
        }
        if (asyncLifecycle) {
          databaseInstances.set(id, { ...existing, status: "deleting", __deleteReads: 0 });
          return noContent();
        }
        databaseInstances.delete(id);
        return noContent();
      }
    }

    return json({ message: `unhandled rdb request ${method} ${pathname}` }, 400);
  };

  const vpcHandler = (method: string, pathname: string, search: string, body: unknown): Response => {
    const segments = pathname.split("/").filter(Boolean);
    const kind = segments[4];
    const id = segments[5];
    const action = segments[6];
    const subnet = segments[7];
    const input = (body ?? {}) as Record<string, unknown>;

    if (kind === "vpcs") {
      if (!id && method === "POST") {
        const record = {
          id: nextId("vpc"),
          region: "fr-par",
          routing_enabled: false,
          custom_routes_propagation_enabled: false,
          tags: [],
          ...input,
        };
        vpcs.set(record.id as string, record);
        return json({ vpc: record });
      }
      const existing = vpcs.get(id);
      if (action === "acl-rules") {
        const isIpv6 = new URLSearchParams(search).get("is_ipv6") === "true";
        const key = `${id}:${isIpv6}`;
        if (method === "GET") {
          return json(
            aclRules.get(key) ?? {
              default_policy: "accept",
              rules: [],
            },
          );
        }
        if (method === "PUT") {
          const record = {
            default_policy: input.default_policy,
            rules: input.rules ?? [],
          };
          aclRules.set(key, record);
          return json(record);
        }
      }
      if (!existing) return json({ message: "vpc not found" }, 404);
      if (!action && method === "GET") return json({ vpc: existing });
      if (!action && method === "PATCH") {
        const updated = { ...existing, ...input };
        vpcs.set(id, updated);
        return json({ vpc: updated });
      }
      if (!action && method === "DELETE") {
        vpcs.delete(id);
        return noContent();
      }
      if (action === "enable-routing" && method === "POST") {
        const updated = { ...existing, routing_enabled: true };
        vpcs.set(id, updated);
        return json({ vpc: updated });
      }
      if (action === "enable-custom-routes-propagation" && method === "POST") {
        const updated = { ...existing, custom_routes_propagation_enabled: true };
        vpcs.set(id, updated);
        return json({ vpc: updated });
      }
    }

    if (kind === "routes") {
      if (!id && method === "POST") {
        const record = {
          id: nextId("route"),
          region: "fr-par",
          is_read_only: false,
          type: "custom",
          tags: [],
          ...input,
        };
        routes.set(record.id as string, record);
        return json({ route: record });
      }
      const existing = routes.get(id);
      if (!existing) return json({ message: "route not found" }, 404);
      if (method === "GET") return json({ route: existing });
      if (method === "PATCH") {
        const updated = { ...existing, ...input };
        routes.set(id, updated);
        return json({ route: updated });
      }
      if (method === "DELETE") {
        routes.delete(id);
        return noContent();
      }
    }

    if (kind === "vpc-connectors") {
      if (!id && method === "POST") {
        const record = {
          id: nextId("vpc-connector"),
          region: "fr-par",
          project_id: "proj-test",
          status: "orphan",
          tags: [],
          ...input,
        };
        vpcConnectors.set(record.id as string, record);
        return json({ vpc_connector: record });
      }
      const existing = vpcConnectors.get(id);
      if (!existing) return json({ message: "vpc connector not found" }, 404);
      if (method === "GET") return json({ vpc_connector: existing });
      if (method === "PATCH") {
        const updated = { ...existing, ...input };
        vpcConnectors.set(id, updated);
        return json({ vpc_connector: updated });
      }
      if (method === "DELETE") {
        vpcConnectors.delete(id);
        return noContent();
      }
    }

    if (kind === "private-networks") {
      if (!id && method === "POST") {
        const record = {
          id: nextId("pn"),
          region: "fr-par",
          tags: [],
          subnets: [],
          dhcp_enabled: false,
          ...input,
        };
        privateNetworks.set(record.id as string, record);
        return json({ private_network: record });
      }
      const existing = privateNetworks.get(id);
      if (!existing) return json({ message: "private network not found" }, 404);
      if (!action && method === "GET") return json({ private_network: existing });
      if (!action && method === "PATCH") {
        const updated = { ...existing, ...input };
        privateNetworks.set(id, updated);
        return json({ private_network: updated });
      }
      if (!action && method === "DELETE") {
        privateNetworks.delete(id);
        return noContent();
      }
      if (action === "enable-dhcp" && method === "POST") {
        const updated = { ...existing, dhcp_enabled: true };
        privateNetworks.set(id, updated);
        return json({ private_network: updated });
      }
      if (action === "subnets" && method === "POST") {
        const subnets = new Set([
          ...(existing.subnets as string[]),
          ...((input.subnets as string[]) ?? []),
        ]);
        const updated = { ...existing, subnets: [...subnets] };
        privateNetworks.set(id, updated);
        return json({ subnets: updated.subnets });
      }
      if (action === "subnets" && method === "DELETE") {
        const deleted = new Set((input.subnets as string[]) ?? []);
        const updated: Record<string, unknown> = {
          ...existing,
          subnets: (existing.subnets as string[]).filter((item) => !deleted.has(item)),
        };
        privateNetworks.set(id, updated);
        return json({ subnets: updated.subnets });
      }
    }

    return json({ message: `unhandled vpc request ${method} ${pathname}${search}` }, 400);
  };

  const parseTagBody = (body: string): Record<string, string> => {
    const tags: Record<string, string> = {};
    for (const [, key, value] of body.matchAll(/<Key>([^<]+)<\/Key><Value>([^<]*)<\/Value>/g)) {
      tags[unescapeXml(key)] = unescapeXml(value);
    }
    return tags;
  };

  const taggingXml = (tags: Record<string, string>) =>
    `<?xml version="1.0"?><Tagging><TagSet>${Object.entries(tags)
      .map(([k, v]) => `<Tag><Key>${escapeXml(k)}</Key><Value>${escapeXml(v)}</Value></Tag>`)
      .join("")}</TagSet></Tagging>`;

  const objectListXml = (keys: string[]) =>
    `<?xml version="1.0"?><ListBucketResult>${keys
      .map((key) => `<Contents><Key>${escapeXml(key)}</Key></Contents>`)
      .join("")}</ListBucketResult>`;

  const objectStorageHandler = (
    method: string,
    host: string,
    pathname: string,
    search: string,
    body: string,
  ): Response => {
    const region = host.split(".")[1] ?? "fr-par";
    const pathParts = pathname.split("/").filter(Boolean);
    const bucketName = pathParts[0];
    const objectKey = pathParts.slice(1).map(decodeURIComponent).join("/");
    const query = search.replace(/^\?/, "");
    const existing = buckets.get(bucketName);

    if (query.startsWith("list-type=2")) {
      if (!existing) return xmlError("NoSuchBucket", "The specified bucket does not exist", 404);
      const params = new URLSearchParams(query);
      const prefix = params.get("prefix") ?? "";
      return new Response(objectListXml([...existing.objects.keys()].filter((key) => key.startsWith(prefix))), {
        status: 200,
      });
    }

    if (query === "versioning") {
      if (method === "PUT") {
        if (existing) existing.versioning = body.includes("<Status>Enabled</Status>");
        return new Response("", { status: 200 });
      }
      if (method === "GET") {
        const status = existing?.versioning ? "Enabled" : "Suspended";
        return new Response(
          `<VersioningConfiguration><Status>${status}</Status></VersioningConfiguration>`,
          { status: 200 },
        );
      }
    }

    if (query === "tagging") {
      if (method === "PUT") {
        if (existing) existing.tags = parseTagBody(body);
        return new Response("", { status: 200 });
      }
      if (method === "DELETE") {
        if (existing) existing.tags = {};
        return new Response("", { status: 204 });
      }
      if (method === "GET") {
        if (!existing || Object.keys(existing.tags).length === 0) {
          return xmlError("NoSuchTagSet", "The TagSet does not exist", 404);
        }
        return new Response(taggingXml(existing.tags), { status: 200 });
      }
    }

    // Bucket-level (no query).
    if (objectKey) {
      if (!existing) return xmlError("NoSuchBucket", "The specified bucket does not exist", 404);
      if (method === "PUT") {
        existing.objects.set(objectKey, body);
        return new Response("", { status: 200 });
      }
      if (method === "GET") {
        const value = existing.objects.get(objectKey);
        if (value === undefined) return xmlError("NoSuchKey", "The specified key does not exist", 404);
        return new Response(value, { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "DELETE") {
        existing.objects.delete(objectKey);
        return noContent();
      }
    }

    if (method === "PUT") {
      buckets.set(bucketName, { region, versioning: false, tags: {}, objects: new Map() });
      return new Response("", { status: 200 });
    }
    if (method === "HEAD") {
      if (!existing) return new Response("", { status: 404 });
      return new Response("", { status: 200, headers: { "x-amz-bucket-region": existing.region } });
    }
    if (method === "DELETE") {
      if (!existing) return xmlError("NoSuchBucket", "The specified bucket does not exist", 404);
      buckets.delete(bucketName);
      return noContent();
    }

    return xmlError(
      "BadRequest",
      `unhandled object storage request ${method} ${pathname}${search}`,
      400,
    );
  };

  const instanceHandler = (method: string, pathname: string, search: string, body: unknown): Response => {
    const segments = pathname.split("/").filter(Boolean);
    const zone = segments[3];
    const kind = segments[4];
    const id = segments[5];
    const nested = segments[6];
    const nestedId = segments[7];
    const input = (body ?? {}) as Record<string, unknown>;
    const params = new URLSearchParams(search);

    const serverPublicIps = (ids: unknown) =>
      ((ids as string[] | undefined) ?? []).map((ipId) => {
        const ip = flexibleIps.get(ipId);
        return {
          id: ipId,
          address: (ip?.address as string | undefined) ?? `203.0.113.${counter + 1}`,
          family: "inet",
          dynamic: false,
          state: "attached",
        };
      });
    const serverVolumes = (serverId: string, serverName: unknown, inputVolumes: unknown) => {
      const entries = Object.entries((inputVolumes as Record<string, Record<string, unknown>> | undefined) ?? {
        "0": { boot: true, volume_type: "sbs_5k", size: 10_000_000_000 },
      });
      return Object.fromEntries(
        entries.map(([key, volume]) => {
          const id = (volume.id as string | undefined) ?? nextId("vol");
          const record = {
            id,
            name: volume.name ?? `${String(serverName ?? "server")}-${key}`,
            size: volume.size,
            volume_type: volume.volume_type ?? "sbs_5k",
            boot: volume.boot,
            project: volume.project ?? "proj-test",
            zone,
            server: { id: serverId, name: serverName },
            state: "in_use",
          };
          if (!volume.id) volumes.set(id, record);
          return [key, { ...volume, ...record }];
        }),
      );
    };

    if (kind === "servers" && nested === "action") {
      const existing = servers.get(id);
      if (!existing) return json({ message: "server not found" }, 404);
      if (input.action === "terminate") {
        for (const volume of Object.values((existing.volumes as Record<string, Record<string, unknown>> | undefined) ?? {})) {
          if (volume.volume_type === "l_ssd" || volume.volume_type === "scratch") volumes.delete(volume.id as string);
          else if (typeof volume.id === "string") volumes.set(volume.id, { ...volume, server: undefined, state: "available" });
        }
        if (asyncLifecycle) {
          servers.set(id, { ...existing, state: "deleting", __deleteReads: 0 });
          return json({ task: { id: nextId("task"), status: "pending" } });
        }
        servers.delete(id);
        serverUserData.delete(id);
        return json({ task: { id: nextId("task"), status: "success" } });
      }
      const state = input.action === "poweroff" || input.action === "stop_in_place"
        ? asyncLifecycle ? "stopping" : "stopped"
        : input.action === "poweron"
          ? asyncLifecycle ? "starting" : "running"
          : existing.state;
      const updated = { ...existing, state, __targetState: state === "stopping" ? "stopped" : state === "starting" ? "running" : undefined, __stateReads: 0 };
      servers.set(id, updated);
      return json({ task: { id: nextId("task"), status: "success" } });
    }

    if (kind === "volumes") {
      const existing = volumes.get(id);
      if (!existing) return json({ message: "volume not found" }, 404);
      if (method === "GET") return json({ volume: existing });
      if (method === "DELETE") {
        if (existing.server) return json({ message: "precondition is not respected" }, 412);
        volumes.delete(id);
        return noContent();
      }
    }

    if (kind === "servers" && nested === "user_data") {
      const existing = servers.get(id);
      if (!existing) return json({ message: "server not found" }, 404);
      const key = decodeURIComponent(nestedId ?? "");
      const values = serverUserData.get(id) ?? new Map<string, string>();
      if (!nestedId && method === "GET") return json({ user_data: [...values.keys()] });
      if (method === "GET") {
        const value = values.get(key);
        if (value === undefined) return json({ message: "user data not found" }, 404);
        return json({ name: key, content_type: "text/plain", content: value });
      }
      if (method === "PATCH") {
        values.set(key, typeof body === "string" ? body : String(body ?? ""));
        serverUserData.set(id, values);
        return noContent();
      }
      if (method === "DELETE") {
        values.delete(key);
        return noContent();
      }
    }

    if (kind === "servers" && !nested) {
      if (!id && method === "POST") {
        const record: Record<string, unknown> = {
          id: nextId("srv"),
          zone,
          state: "stopped",
          boot_type: input.boot_type ?? "local",
          dynamic_ip_required: input.dynamic_ip_required,
          routed_ip_enabled: input.routed_ip_enabled,
          protected: input.protected ?? false,
          tags: [],
          ...input,
          project: input.project ?? "proj-test",
          image: input.image ? { id: input.image, name: input.image } : undefined,
          public_ips: serverPublicIps(input.public_ips),
          security_group: input.security_group ? { id: input.security_group } : undefined,
          placement_group: input.placement_group ? { id: input.placement_group } : undefined,
          dns: `${input.name}.test.local`,
        };
        record.volumes = serverVolumes(record.id as string, input.name, input.volumes);
        servers.set(record.id as string, record);
        return json({ server: record }, 201);
      }
      const existing = servers.get(id);
      if (!existing) return json({ message: "server not found" }, 404);
      if (method === "GET") {
        if (asyncLifecycle && existing.state === "deleting") {
          const deleteReads = Number(existing.__deleteReads ?? 0);
          if (deleteReads > 0) {
            const updated = { ...existing, __deleteReads: deleteReads - 1 };
            servers.set(id, updated);
            return json({ server: updated });
          }
          servers.delete(id);
          serverUserData.delete(id);
          return json({ message: "server not found" }, 404);
        }
        if (asyncLifecycle && (existing.state === "starting" || existing.state === "stopping")) {
          const stateReads = Number(existing.__stateReads ?? 0);
          if (stateReads > 0) {
            const updated = { ...existing, __stateReads: stateReads - 1 };
            servers.set(id, updated);
            return json({ server: updated });
          }
          const updated = { ...existing, state: existing.__targetState ?? existing.state, __stateReads: 0, __targetState: undefined };
          servers.set(id, updated);
          return json({ server: updated });
        }
        return json({ server: existing });
      }
      if (method === "PATCH") {
        const updated: Record<string, unknown> = {
          ...existing,
          ...input,
          public_ips: input.public_ips === undefined ? existing.public_ips : serverPublicIps(input.public_ips),
          security_group: input.security_group === null ? undefined : input.security_group ? input.security_group : existing.security_group,
          placement_group: input.placement_group === null ? undefined : input.placement_group ? { id: input.placement_group } : existing.placement_group,
        };
        servers.set(id, updated);
        return json({ server: updated });
      }
      if (method === "DELETE") {
        for (const volume of Object.values((existing.volumes as Record<string, Record<string, unknown>> | undefined) ?? {})) {
          if (volume.volume_type === "l_ssd" || volume.volume_type === "scratch") volumes.delete(volume.id as string);
          else if (typeof volume.id === "string") volumes.set(volume.id, { ...volume, server: undefined, state: "available" });
        }
        if (asyncLifecycle) {
          servers.set(id, { ...existing, state: "deleting", __deleteReads: 0 });
          return noContent();
        }
        servers.delete(id);
        serverUserData.delete(id);
        return noContent();
      }
    }

    if (kind === "security_groups") {
      if (!id && method === "POST") {
        const record = { id: nextId("sg"), zone, state: "available", tags: [], ...input };
        securityGroups.set(record.id as string, record);
        return json({ security_group: record }, 201);
      }
      const existing = securityGroups.get(id);
      if (!existing) return json({ message: "security group not found" }, 404);
      if (!nested && method === "GET") return json({ security_group: existing });
      if (!nested && method === "PATCH") {
        const updated = { ...existing, ...input };
        securityGroups.set(id, updated);
        return json({ security_group: updated });
      }
      if (!nested && method === "DELETE") {
        securityGroups.delete(id);
        securityGroupRules.delete(id);
        return noContent();
      }
      if (nested === "rules") {
        if (!nestedId && method === "PUT") {
          const rules = ((input.rules as Array<Record<string, unknown>>) ?? []).map((rule, index) => ({
            id: (rule.id as string | undefined) ?? nextId("sgr"),
            zone,
            editable: true,
            position: index,
            ...rule,
            dest_port_to: rule.dest_port_to === rule.dest_port_from ? null : rule.dest_port_to,
          }));
          securityGroupRules.set(id, rules);
          return json({ rules });
        }
        if (!nestedId && method === "GET") return json({ rules: securityGroupRules.get(id) ?? [] });
      }
    }

    if (kind === "ips") {
      if (!id && method === "GET") {
        const project = params.get("project") ?? undefined;
        const matching = [...flexibleIps.values()].filter((ip) =>
          ip.zone === zone && (!project || ip.project === project)
        );
        const page = pageOf(matching, params);
        return json({ ips: page.items, total_count: page.total_count });
      }
      if (!id && method === "POST") {
        const record = {
          id: nextId("ip"),
          zone,
          address: `203.0.113.${counter + 1}`,
          state: "attached",
          type: input.type ?? "routed_ipv4",
          tags: [],
          ...input,
          server: input.server ? { id: input.server } : undefined,
        };
        flexibleIps.set(record.id as string, record);
        return json({ ip: record }, 201);
      }
      const existing = flexibleIps.get(id) ?? [...flexibleIps.values()].find((ip) => ip.address === id);
      if (!existing) return json({ message: "ip not found" }, 404);
      if (method === "GET") return json({ ip: existing });
      if (method === "PATCH") {
        const updated: Record<string, unknown> = {
          ...existing,
          ...input,
          server: input.server === null ? undefined : input.server ? { id: input.server } : existing.server,
        };
        flexibleIps.set(existing.id as string, updated);
        for (const [serverId, server] of servers) {
          const publicIps = ((server.public_ips as Array<Record<string, unknown>> | undefined) ?? []).filter((ip) => ip.id !== existing.id);
          if ((updated.server as { id?: string } | undefined)?.id === serverId) {
            publicIps.push({
              id: existing.id,
              address: updated.address as string,
              family: "inet",
              dynamic: false,
              state: "attached",
            });
          }
          servers.set(serverId, { ...server, public_ips: publicIps });
        }
        return json({ ip: updated });
      }
      if (method === "DELETE") {
        flexibleIps.delete(existing.id as string);
        return noContent();
      }
    }

    if (kind === "servers" && nested === "private_nics") {
      const key = (privateNicId: string) => `${id}:${privateNicId}`;
      if (!nestedId && method === "POST") {
        const record = {
          id: nextId("pnic"),
          zone,
          server_id: id,
          mac_address: "02:00:00:00:00:01",
          state: "available",
          tags: [],
          ipam_ip_ids: input.ipam_ip_ids ?? [nextId("ipam")],
          ...input,
        };
        privateNics.set(key(record.id as string), record);
        return json({ private_nic: record }, 201);
      }
      const existing = privateNics.get(key(nestedId));
      if (!existing) return json({ message: "private nic not found" }, 404);
      if (method === "GET") return json({ private_nic: existing });
      if (method === "PATCH") {
        const updated = { ...existing, ...input };
        privateNics.set(key(nestedId), updated);
        return json(updated);
      }
      if (method === "DELETE") {
        privateNics.delete(key(nestedId));
        return noContent();
      }
    }

    return json({ message: `unhandled instance request ${method} ${pathname}` }, 400);
  };

  const blockHandler = (method: string, pathname: string): Response => {
    const segments = pathname.split("/").filter(Boolean);
    const id = segments[5];
    const existing = volumes.get(id);
    if (!existing) return json({ message: "volume not found" }, 404);
    if (method === "DELETE") {
      if (existing.server) return json({ message: "precondition is not respected" }, 412);
      volumes.delete(id);
      return noContent();
    }
    return json({ id: existing.id, type: existing.volume_type, status: existing.state, ...existing });
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Our Containers client calls `fetch(url, { method, body })`; aws4fetch
    // signs and calls `fetch(Request)` with a single argument, so the method
    // and body live on the Request, not on `init`.
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    const method = ((isRequest ? (input as Request).method : init?.method) ?? "GET").toUpperCase();
    const parsed = new URL(url);
    const headers = new Headers(isRequest ? (input as Request).headers : init?.headers);
    const text = isRequest
      ? await (input as Request).clone().text()
      : typeof init?.body === "string"
        ? init.body
        : "";
    calls.push({ method, url, headers, body: text });

    const forcedIndex = forcedErrors.findIndex((e) => url.includes(e.fragment));
    if (forcedIndex >= 0) {
      const [forced] = forcedErrors.splice(forcedIndex, 1);
      return json({ message: forced.message }, forced.status);
    }

    if (parsed.host === "api.scaleway.com") {
      const parsedBody = text.length > 0 && !headers.get("content-type")?.startsWith("text/plain") ? JSON.parse(text) : text.length > 0 ? text : undefined;
      if (parsed.pathname.startsWith("/account/")) {
        return accountHandler(method, parsed.pathname, parsed.search, parsedBody);
      }
      if (parsed.pathname.startsWith("/registry/")) {
        return registryHandler(method, parsed.pathname, parsedBody);
      }
      if (parsed.pathname.startsWith("/secret-manager/")) {
        return secretManagerHandler(method, parsed.pathname, parsedBody);
      }
      if (parsed.pathname.startsWith("/rdb/")) {
        return rdbHandler(method, parsed.pathname, parsed.search, parsedBody);
      }
      if (parsed.pathname.startsWith("/vpc/")) {
        return vpcHandler(method, parsed.pathname, parsed.search, parsedBody);
      }
      if (parsed.pathname.startsWith("/domain/")) {
        return dnsHandler(method, parsed.pathname, parsed.search, parsedBody);
      }
      if (parsed.pathname.startsWith("/instance/")) {
        return instanceHandler(method, parsed.pathname, parsed.search, parsedBody);
      }
      if (parsed.pathname.startsWith("/block/")) {
        return blockHandler(method, parsed.pathname);
      }
      return containersHandler(method, parsed.pathname, parsedBody);
    }
    if (parsed.host.endsWith(".scw.cloud")) {
      return objectStorageHandler(method, parsed.host, parsed.pathname, parsed.search, text);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
    enableAsyncLifecycle: () => {
      asyncLifecycle = true;
    },
    addFlexibleIp: (id) => flexibleIps.set(id, { id, zone: "fr-par-1", project: "proj-test", address: `203.0.113.${counter + 1}`, state: "attached", type: "routed_ipv4", tags: [] }),
    setFlexibleIpTags: (id, tags) => {
      const existing = flexibleIps.get(id);
      if (existing) flexibleIps.set(id, { ...existing, tags });
    },
    removeContainer: (id) => containers.delete(id),
    removeVpc: (id) => vpcs.delete(id),
    removePrivateNetwork: (id) => privateNetworks.delete(id),
    removeRoute: (id) => routes.delete(id),
    removeVpcConnector: (id) => vpcConnectors.delete(id),
    removeServer: (id) => servers.delete(id),
    removeSecurityGroup: (id) => securityGroups.delete(id),
    removeFlexibleIp: (id) => flexibleIps.delete(id),
    removePrivateNic: (serverId, id) => privateNics.delete(`${serverId}:${id}`),
    removeBucket: (name) => buckets.delete(name),
    seedBucket: (name, region, tags = {}) =>
      buckets.set(name, { region, versioning: false, tags, objects: new Map() }),
    seedDnsZone: (dnsZone, projectId = "proj-test") => {
      const record = zoneRecordOf(dnsZone, projectId);
      dnsZones.set(zoneKeyOf(record), record);
    },
    failNextDomainDeploys: (count) => {
      domainDeployErrorsRemaining = count;
    },
    failNext: (fragment, status, message) => forcedErrors.push({ fragment, status, message }),
  };
}
