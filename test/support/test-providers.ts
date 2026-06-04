// A Scaleway providers layer wired with fixed in-memory credentials, so
// provider lifecycle tests skip the interactive auth flow but still exercise
// the real `makeScalewayClients` / resource reconcilers.
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Provider from "alchemy/Provider";
import { Bucket, BucketProvider } from "../../src/Bucket.ts";
import { Container, ContainerProvider } from "../../src/Container.ts";
import { ScalewayCredentials } from "../../src/Credentials.ts";
import { Domain, DomainProvider } from "../../src/Domain.ts";
import { Namespace, NamespaceProvider } from "../../src/Namespace.ts";
import { Providers } from "../../src/Providers.ts";
import { Trigger, TriggerProvider } from "../../src/Trigger.ts";

const credentialsLayer = Layer.succeed(
  ScalewayCredentials,
  ScalewayCredentials.of({
    secretKey: Redacted.make("test-secret"),
    accessKey: "test-access",
    region: "fr-par",
    apiUrl: "https://api.scaleway.com",
    projectId: "proj-test",
  }),
);

export const testProviders = () =>
  Layer.effect(
    Providers,
    Provider.collection([Namespace, Container, Trigger, Domain, Bucket]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        NamespaceProvider(),
        ContainerProvider(),
        TriggerProvider(),
        DomainProvider(),
        BucketProvider(),
      ),
    ),
    Layer.provideMerge(credentialsLayer),
    Layer.orDie,
  );
