import * as Layer from "effect/Layer";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import { ScalewayAuth } from "./AuthProvider.ts";
import { Bucket, BucketProvider } from "./Bucket.ts";
import { Container, ContainerProvider } from "./Container.ts";
import { ContainerImage, ContainerImageProvider } from "./ContainerImage.ts";
import * as Credentials from "./Credentials.ts";
import { DatabaseInstance, DatabaseInstanceProvider } from "./DatabaseInstance.ts";
import { Domain, DomainProvider } from "./Domain.ts";
import { DnsRecord, DnsRecordProvider } from "./DnsRecord.ts";
import { DnsZone, DnsZoneProvider } from "./DnsZone.ts";
import { FlexibleIp, FlexibleIpProvider } from "./FlexibleIp.ts";
import { Function as ScalewayFunction, FunctionProvider } from "./Function.ts";
import { FunctionCron, FunctionCronProvider } from "./FunctionCron.ts";
import { FunctionDomain, FunctionDomainProvider } from "./FunctionDomain.ts";
import { FunctionNamespace, FunctionNamespaceProvider } from "./FunctionNamespace.ts";
import { Instance, InstanceProvider } from "./Instance.ts";
import { Namespace, NamespaceProvider } from "./Namespace.ts";
import { PrivateNic, PrivateNicProvider } from "./PrivateNic.ts";
import { PrivateNetwork, PrivateNetworkProvider } from "./PrivateNetwork.ts";
import { Project, ProjectProvider } from "./Project.ts";
import { RegistryNamespace, RegistryNamespaceProvider } from "./RegistryNamespace.ts";
import { Secret, SecretProvider } from "./Secret.ts";
import { SecurityGroup, SecurityGroupProvider } from "./SecurityGroup.ts";
import { Trigger, TriggerProvider } from "./Trigger.ts";
import { Vpc, VpcProvider } from "./Vpc.ts";
import { VpcAcl, VpcAclProvider } from "./VpcAcl.ts";
import { VpcConnector, VpcConnectorProvider } from "./VpcConnector.ts";
import { VpcRoute, VpcRouteProvider } from "./VpcRoute.ts";
import { ScalewayProviderConfig, type ProjectRef } from "./Internal.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Scaleway") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

export interface ScalewayProviderOptions {
  project?: ProjectRef;
}

export const providers = (options: ScalewayProviderOptions = {}) =>
  Layer.effect(
    Providers,
    Provider.collection([
      Namespace,
      Project,
      Container,
      ContainerImage,
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
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(
      Layer.succeed(
        ScalewayProviderConfig,
        ScalewayProviderConfig.of({ project: options.project }),
      ),
    ),
    Layer.provideMerge(ScalewayAuth),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
