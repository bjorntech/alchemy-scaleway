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
  const containers = new Map<string, Record<string, unknown>>();
  const crons = new Map<string, Record<string, unknown>>();
  const domains = new Map<string, Record<string, unknown>>();
  const buckets = new Map<string, BucketState>();
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;
  const forcedErrors: Array<{ fragment: string; status: number; message: string }> = [];

  const containersHandler = (method: string, pathname: string, body: unknown): Response => {
    const segments = pathname.split("/").filter(Boolean); // [containers, v1beta1, regions, fr-par, <kind>, <id?>, <sub?>]
    const kind = segments[4];
    const id = segments[5];
    const sub = segments[6];
    const input = (body ?? {}) as Record<string, unknown>;

    if (kind === "namespaces") {
      if (method === "POST") {
        const record = { id: nextId("ns"), region: "fr-par", status: "ready", ...input };
        namespaces.set(record.id as string, record);
        return json({ namespace: record });
      }
      const existing = namespaces.get(id);
      if (!existing) return json({ message: "namespace not found" }, 404);
      if (method === "GET") return json({ namespace: existing });
      if (method === "PATCH") {
        const updated = { ...existing, ...input };
        namespaces.set(id, updated);
        return json({ namespace: updated });
      }
      if (method === "DELETE") {
        namespaces.delete(id);
        return noContent();
      }
    }

    if (kind === "containers") {
      if (sub === "deploy" && method === "POST") return json({});
      if (method === "POST") {
        const record = {
          id: nextId("ctr"),
          region: "fr-par",
          status: "ready",
          endpoint: `https://${nextId("ep")}.functions.fnc.fr-par.scw.cloud`,
          project_id: "proj-test",
          ...input,
        };
        containers.set(record.id as string, record);
        return json({ container: record });
      }
      const existing = containers.get(id);
      if (!existing) return json({ message: "container not found" }, 404);
      if (method === "GET") return json({ container: existing });
      if (method === "PATCH") {
        const updated = { ...existing, ...input, status: "ready" };
        containers.set(id, updated);
        return json({ container: updated });
      }
      if (method === "DELETE") {
        containers.delete(id);
        return noContent();
      }
    }

    if (kind === "crons") {
      if (method === "POST") {
        const record = { id: nextId("cron"), status: "ready", ...input };
        crons.set(record.id as string, record);
        return json({ cron: record });
      }
      const existing = crons.get(id);
      if (!existing) return json({ message: "cron not found" }, 404);
      if (method === "GET") return json({ cron: existing });
      if (method === "PATCH") {
        const updated = { ...existing, ...input, status: "ready" };
        crons.set(id, updated);
        return json({ cron: updated });
      }
      if (method === "DELETE") {
        crons.delete(id);
        return noContent();
      }
    }

    if (kind === "domains") {
      if (method === "POST") {
        const hostname = input.hostname as string;
        const record = { id: nextId("dom"), status: "ready", url: `https://${hostname}`, ...input };
        domains.set(record.id as string, record);
        return json({ domain: record });
      }
      const existing = domains.get(id);
      if (!existing) return json({ message: "domain not found" }, 404);
      if (method === "GET") return json({ domain: existing });
      if (method === "DELETE") {
        domains.delete(id);
        return noContent();
      }
    }

    return json({ message: `unhandled containers request ${method} ${pathname}` }, 400);
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
    calls.push({ method, url, headers });
    const text = isRequest
      ? await (input as Request).clone().text()
      : typeof init?.body === "string"
        ? init.body
        : "";

    const forcedIndex = forcedErrors.findIndex((e) => url.includes(e.fragment));
    if (forcedIndex >= 0) {
      const [forced] = forcedErrors.splice(forcedIndex, 1);
      return json({ message: forced.message }, forced.status);
    }

    if (parsed.host === "api.scaleway.com") {
      const parsedBody = text.length > 0 ? JSON.parse(text) : undefined;
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
