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
import { DnsRecord, DnsRecordProvider } from "../../src/DnsRecord.ts";
import { DnsZone, DnsZoneProvider } from "../../src/DnsZone.ts";
import { FlexibleIp, FlexibleIpProvider } from "../../src/FlexibleIp.ts";
import { Instance, InstanceProvider } from "../../src/Instance.ts";
import { Namespace, NamespaceProvider } from "../../src/Namespace.ts";
import { PrivateNic, PrivateNicProvider } from "../../src/PrivateNic.ts";
import { PrivateNetwork, PrivateNetworkProvider } from "../../src/PrivateNetwork.ts";
import { Providers } from "../../src/Providers.ts";
import { RegistryNamespace, RegistryNamespaceProvider } from "../../src/RegistryNamespace.ts";
import { Secret, SecretProvider } from "../../src/Secret.ts";
import { SecurityGroup, SecurityGroupProvider } from "../../src/SecurityGroup.ts";
import { Trigger, TriggerProvider } from "../../src/Trigger.ts";
import { Vpc, VpcProvider } from "../../src/Vpc.ts";
import { VpcAcl, VpcAclProvider } from "../../src/VpcAcl.ts";
import { VpcConnector, VpcConnectorProvider } from "../../src/VpcConnector.ts";
import { VpcRoute, VpcRouteProvider } from "../../src/VpcRoute.ts";

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
    Provider.collection([
      Namespace,
      Container,
      Trigger,
      Domain,
      DnsZone,
      DnsRecord,
      RegistryNamespace,
      Secret,
      Bucket,
      Vpc,
      PrivateNetwork,
      VpcAcl,
      VpcRoute,
      VpcConnector,
      Instance,
      SecurityGroup,
      FlexibleIp,
      PrivateNic,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        NamespaceProvider(),
        ContainerProvider(),
        TriggerProvider(),
        DomainProvider(),
        DnsZoneProvider(),
        DnsRecordProvider(),
        RegistryNamespaceProvider(),
        SecretProvider(),
        BucketProvider(),
        VpcProvider(),
        PrivateNetworkProvider(),
        VpcAclProvider(),
        VpcRouteProvider(),
        VpcConnectorProvider(),
        InstanceProvider(),
        SecurityGroupProvider(),
        FlexibleIpProvider(),
        PrivateNicProvider(),
      ),
    ),
    Layer.provideMerge(credentialsLayer),
    Layer.orDie,
  );
