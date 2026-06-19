// A Scaleway providers layer wired with fixed in-memory credentials, so
// provider lifecycle tests skip the interactive auth flow but still exercise
// the real `makeScalewayClients` / resource reconcilers.
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Provider from "alchemy/Provider";
import { Bucket, BucketProvider } from "../../src/Bucket.ts";
import { Container, ContainerProvider } from "../../src/Container.ts";
import { ContainerImage, ContainerImageProvider } from "../../src/ContainerImage.ts";
import { ContainerImageMirror, ContainerImageMirrorProvider } from "../../src/ContainerImageMirror.ts";
import { ScalewayCredentials } from "../../src/Credentials.ts";
import { DatabaseInstance, DatabaseInstanceProvider } from "../../src/DatabaseInstance.ts";
import { Domain, DomainProvider } from "../../src/Domain.ts";
import { DnsRecord, DnsRecordProvider } from "../../src/DnsRecord.ts";
import { DnsZone, DnsZoneProvider } from "../../src/DnsZone.ts";
import { FlexibleIp, FlexibleIpProvider } from "../../src/FlexibleIp.ts";
import { Function as ScalewayFunction, FunctionProvider } from "../../src/Function.ts";
import { FunctionCron, FunctionCronProvider } from "../../src/FunctionCron.ts";
import { FunctionDomain, FunctionDomainProvider } from "../../src/FunctionDomain.ts";
import { FunctionNamespace, FunctionNamespaceProvider } from "../../src/FunctionNamespace.ts";
import { Instance, InstanceProvider } from "../../src/Instance.ts";
import { ScalewayProviderConfig, type ProjectRef } from "../../src/Internal.ts";
import { Namespace, NamespaceProvider } from "../../src/Namespace.ts";
import { PrivateNic, PrivateNicProvider } from "../../src/PrivateNic.ts";
import { PrivateNetwork, PrivateNetworkProvider } from "../../src/PrivateNetwork.ts";
import { Project, ProjectProvider } from "../../src/Project.ts";
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

export const testProviders = (options: { project?: ProjectRef } = {}) =>
  Layer.effect(
    Providers,
    Provider.collection([
      Namespace,
      Project,
      Container,
      ContainerImage,
      ContainerImageMirror,
      Trigger,
      Domain,
      FunctionNamespace,
      ScalewayFunction,
      FunctionCron,
      FunctionDomain,
      DnsZone,
      DnsRecord,
      RegistryNamespace,
      Secret,
      DatabaseInstance,
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
        ProjectProvider(),
        ContainerProvider(),
        ContainerImageProvider(),
        ContainerImageMirrorProvider(),
        TriggerProvider(),
        DomainProvider(),
        FunctionNamespaceProvider(),
        FunctionProvider(),
        FunctionCronProvider(),
        FunctionDomainProvider(),
        DnsZoneProvider(),
        DnsRecordProvider(),
        RegistryNamespaceProvider(),
        SecretProvider(),
        DatabaseInstanceProvider(),
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
    Layer.provideMerge(
      Layer.succeed(
        ScalewayProviderConfig,
        ScalewayProviderConfig.of({ project: options.project }),
      ),
    ),
    Layer.orDie,
  );
