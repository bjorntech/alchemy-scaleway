import * as Layer from "effect/Layer";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import { ScalewayAuth } from "./AuthProvider.ts";
import { Bucket, BucketProvider } from "./Bucket.ts";
import { Container, ContainerProvider } from "./Container.ts";
import * as Credentials from "./Credentials.ts";
import { Domain, DomainProvider } from "./Domain.ts";
import { Namespace, NamespaceProvider } from "./Namespace.ts";
import { PrivateNetwork, PrivateNetworkProvider } from "./PrivateNetwork.ts";
import { RegistryNamespace, RegistryNamespaceProvider } from "./RegistryNamespace.ts";
import { Secret, SecretProvider } from "./Secret.ts";
import { Trigger, TriggerProvider } from "./Trigger.ts";
import { Vpc, VpcProvider } from "./Vpc.ts";
import { VpcAcl, VpcAclProvider } from "./VpcAcl.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Scaleway") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Namespace,
      Container,
      Trigger,
      Domain,
      RegistryNamespace,
      Secret,
      Bucket,
      Vpc,
      PrivateNetwork,
      VpcAcl,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        NamespaceProvider(),
        ContainerProvider(),
        TriggerProvider(),
        DomainProvider(),
        RegistryNamespaceProvider(),
        SecretProvider(),
        BucketProvider(),
        VpcProvider(),
        PrivateNetworkProvider(),
        VpcAclProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(ScalewayAuth),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
