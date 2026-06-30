import { Stack, StackProps, Duration, Tags, CfnOutput } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';
import { KeycloakHaConfig } from './config';

/**
 * CloudFrontStack puts CloudFront in front of the ALB.
 *
 * - Viewer protocol: REDIRECT_TO_HTTPS (users always get HTTPS).
 * - Origin protocol: HTTP by default (no custom domain). Switches to HTTPS when a
 *   custom domain + ACM certs are configured -> full end-to-end TLS.
 * - Cache: CACHING_DISABLED (auth is dynamic, never cache).
 * - Origin request: ALL_VIEWER (forward all headers, cookies, query strings -
 *   required for OIDC code/state, SAML POST, and Keycloak session cookies).
 * - Methods: ALLOW_ALL (SAML POST binding and admin API need POST/PUT/DELETE).
 */
export interface CloudFrontStackProps extends StackProps {
  readonly config: KeycloakHaConfig;
  readonly alb: elbv2.IApplicationLoadBalancer;
}

export class CloudFrontStack extends Stack {
  public readonly distribution: cloudfront.Distribution;
  /** Public hostname (custom domain when enabled, else the *.cloudfront.net name). */
  public readonly publicDomainName: string;

  constructor(scope: Construct, id: string, props: CloudFrontStackProps) {
    super(scope, id, props);
    const { config, alb } = props;
    const cd = config.cloudfront.customDomain;

    const origin = new origins.LoadBalancerV2Origin(alb, {
      protocolPolicy: cd.enabled
        ? cloudfront.OriginProtocolPolicy.HTTPS_ONLY
        : cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
      httpsPort: 443,
      readTimeout: Duration.seconds(60),
      keepaliveTimeout: Duration.seconds(60),
    });

    let certificate: acm.ICertificate | undefined;
    let domainNames: string[] | undefined;
    if (cd.enabled) {
      if (!cd.domainName || !cd.viewerCertArnUsEast1) {
        throw new Error(
          'customDomain.enabled=true requires domainName and viewerCertArnUsEast1 (ACM cert in us-east-1).',
        );
      }
      certificate = acm.Certificate.fromCertificateArn(
        this,
        'ViewerCert',
        cd.viewerCertArnUsEast1,
      );
      domainNames = [cd.domainName];
    }

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${config.project} Keycloak IdP`,
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        responseHeadersPolicy:
          cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      domainNames,
      certificate,
    });

    this.publicDomainName = cd.enabled
      ? cd.domainName!
      : this.distribution.distributionDomainName;

    new CfnOutput(this, 'CloudFrontDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront distribution domain name',
    });
    new CfnOutput(this, 'KeycloakPublicUrl', {
      value: `https://${this.publicDomainName}`,
      description: 'Public Keycloak base URL (set as KC_HOSTNAME)',
    });

    Tags.of(this).add('Component', 'cloudfront');
  }
}
