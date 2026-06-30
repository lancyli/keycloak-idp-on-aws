import { Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { KeycloakHaConfig } from './config';

/**
 * NetworkStack provisions the VPC and all networking primitives.
 *
 * Subnet tiers:
 *   - public   : ALB lives here (internet-facing, but locked to CloudFront via SG).
 *   - private  : EKS worker nodes / Keycloak pods (egress via NAT).
 *   - isolated : Aurora PostgreSQL (no internet route at all).
 *
 * Interface/Gateway VPC endpoints keep AWS API traffic (ECR, STS, Secrets Manager,
 * CloudWatch Logs, S3) off the public internet and reduce NAT data charges.
 */
export interface NetworkStackProps extends StackProps {
  readonly config: KeycloakHaConfig;
}

export class NetworkStack extends Stack {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(config.vpc.cidr),
      maxAzs: config.vpc.maxAzs,
      natGateways: config.vpc.natGateways,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 22, // room for many EKS pods/ENIs
        },
        {
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // Tag subnets so the AWS Load Balancer Controller can auto-discover them.
    for (const subnet of this.vpc.publicSubnets) {
      Tags.of(subnet).add('kubernetes.io/role/elb', '1');
    }
    for (const subnet of this.vpc.privateSubnets) {
      Tags.of(subnet).add('kubernetes.io/role/internal-elb', '1');
    }

    // Gateway endpoint for S3 (ECR layers, EKS artifacts) - free.
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // Interface endpoints used by EKS nodes / pods in private subnets.
    const interfaceEndpoints: { [id: string]: ec2.InterfaceVpcEndpointAwsService } = {
      EcrApi: ec2.InterfaceVpcEndpointAwsService.ECR,
      EcrDkr: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      Sts: ec2.InterfaceVpcEndpointAwsService.STS,
      SecretsManager: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      CloudWatchLogs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      Ec2: ec2.InterfaceVpcEndpointAwsService.EC2,
      Elb: ec2.InterfaceVpcEndpointAwsService.ELASTIC_LOAD_BALANCING,
    };

    for (const [id, service] of Object.entries(interfaceEndpoints)) {
      this.vpc.addInterfaceEndpoint(id, {
        service,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        privateDnsEnabled: true,
      });
    }

    Tags.of(this).add('Component', 'network');
  }
}
