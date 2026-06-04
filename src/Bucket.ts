import { Resource } from "alchemy";
import * as Provider from "alchemy/Provider";
import { isResolved } from "alchemy/Diff";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import { makeScalewayClients, type ObjectStorageBucketRecord } from "./Clients.ts";
import { isNotFound } from "./Errors.ts";
import { hasAlchemyTags, physicalName, recordEquals, withAlchemyTags } from "./Internal.ts";
import type { Providers } from "./Providers.ts";

export interface BucketProps {
  name?: string;
  region?: string;
  tags?: Record<string, string>;
  versioning?: boolean;
}

export type Bucket = Resource<
  "Scaleway.Bucket",
  BucketProps,
  {
    bucketName: string;
    region: string;
    endpoint: string;
    tags?: Record<string, string>;
    versioning?: boolean;
  },
  never,
  Providers
>;

export const Bucket = Resource<Bucket>("Scaleway.Bucket");

// @crap-ignore: provider factory wraps lifecycle closures scored separately.
export const BucketProvider = () =>
  Provider.effect(
    Bucket,
    Effect.gen(function* () {
      const clients = yield* makeScalewayClients;
      const nameOf = (id: string, name?: string) => physicalName(id, name, { maxLength: 63 });
      const toAttributes = (record: ObjectStorageBucketRecord): Bucket["Attributes"] => ({
        bucketName: record.name,
        region: record.region,
        endpoint: record.endpoint,
        tags: record.tags,
        versioning: record.versioning,
      });

      return Bucket.Provider.of({
        stables: ["bucketName", "region", "endpoint"],
        diff: Effect.fnUntraced(function* ({ id, news, olds, output }) {
          if (!isResolved(news) || !output) return undefined;
          const name = yield* nameOf(id, news.name);
          const region = news.region ?? clients.region;
          if (output.bucketName !== name || output.region !== region)
            return { action: "replace" } as const;
          if (olds.versioning !== news.versioning || !recordEquals(olds.tags, news.tags))
            return { action: "update" } as const;
          return undefined;
        }),
        read: Effect.fnUntraced(function* ({ id, olds, output }) {
          const name = output?.bucketName ?? (yield* nameOf(id, olds?.name));
          const region = output?.region ?? olds?.region ?? clients.region;
          const bucket = yield* clients.objectStorage
            .getBucket({ name, region })
            .pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
          if (!bucket) return undefined;
          const attrs = toAttributes(bucket);
          return output || hasAlchemyTags(id, bucket.tags) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fnUntraced(function* ({ id, news, output, session }) {
          const name = output?.bucketName ?? (yield* nameOf(id, news.name));
          const region = output?.region ?? news.region ?? clients.region;
          const tags = withAlchemyTags(id, news.tags);
          if (output?.bucketName) {
            const updated = yield* clients.objectStorage.updateBucket({
              name,
              region,
              tags,
              versioning: news.versioning,
            });
            yield* session.note(`Updated Scaleway bucket ${name}`);
            return toAttributes(updated);
          }
          const created = yield* clients.objectStorage.createBucket({
            name,
            region,
            tags,
            versioning: news.versioning,
          });
          yield* session.note(`Created Scaleway bucket ${name}`);
          return toAttributes(created);
        }),
        delete: Effect.fnUntraced(function* ({ output, session }) {
          yield* clients.objectStorage
            .deleteBucket({ name: output.bucketName, region: output.region })
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
          yield* session.note(`Deleted Scaleway bucket ${output.bucketName}`);
        }),
      });
    }),
  );
