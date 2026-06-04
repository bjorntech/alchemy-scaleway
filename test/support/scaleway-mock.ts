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
  /** Drop a record so the next `read`/`get` behaves like a 404. */
  removeContainer(id: string): void;
  removeBucket(name: string): void;
  /** Seed a bucket that Alchemy does not own (no `alchemy:logical-id` tag). */
  seedBucket(name: string, region: string, tags?: Record<string, string>): void;
  /** Make the next matching Containers request fail with a status + message. */
  failNext(urlFragment: string, status: number, message: string): void;
}

interface BucketState {
  region: string;
  versioning: boolean;
  tags: Record<string, string>;
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
  const containers = new Map<string, Record<string, unknown>>();
  const triggers = new Map<string, Record<string, unknown>>();
  const domains = new Map<string, Record<string, unknown>>();
  const buckets = new Map<string, BucketState>();
  let counter = 0;
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
        const record = {
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
        const record = { id: nextId("dom"), status: "ready", ...input };
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

  const registryHandler = (method: string, pathname: string, body: unknown): Response => {
    const segments = pathname.split("/").filter(Boolean); // [registry, v1, regions, fr-par, namespaces, id?]
    const kind = segments[4];
    const id = segments[5];
    const input = (body ?? {}) as Record<string, unknown>;

    if (kind === "namespaces") {
      if (method === "POST") {
        const record = {
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

  const objectStorageHandler = (
    method: string,
    host: string,
    pathname: string,
    search: string,
    body: string,
  ): Response => {
    const region = host.split(".")[1] ?? "fr-par";
    const bucketName = pathname.split("/").filter(Boolean)[0];
    const query = search.replace(/^\?/, "");
    const existing = buckets.get(bucketName);

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
    if (method === "PUT") {
      buckets.set(bucketName, { region, versioning: false, tags: {} });
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
      const parsedBody = text.length > 0 ? JSON.parse(text) : undefined;
      if (parsed.pathname.startsWith("/registry/")) {
        return registryHandler(method, parsed.pathname, parsedBody);
      }
      if (parsed.pathname.startsWith("/secret-manager/")) {
        return secretManagerHandler(method, parsed.pathname, parsedBody);
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
    removeContainer: (id) => containers.delete(id),
    removeBucket: (name) => buckets.delete(name),
    seedBucket: (name, region, tags = {}) => buckets.set(name, { region, versioning: false, tags }),
    failNext: (fragment, status, message) => forcedErrors.push({ fragment, status, message }),
  };
}
