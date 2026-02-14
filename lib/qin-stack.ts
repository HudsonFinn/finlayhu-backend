import { RemovalPolicy, Stack, StackProps, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Bucket, EventType } from "aws-cdk-lib/aws-s3";
import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";
import {
  Distribution,
  OriginAccessIdentity,
  CachePolicy,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
} from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";

const QIN_DOMAIN = "qin.fhudson.com";
const CERTIFICATE_ARN =
  "arn:aws:acm:us-east-1:457471291771:certificate/6289263c-411b-4981-9c2a-a872d19fe0e7";

export class QinStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const qinBucket = new Bucket(this, "QinBucket", {
      bucketName: "qin-fhudson-com",
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const qinAOI = new OriginAccessIdentity(this, "QinAOI");
    qinBucket.grantRead(qinAOI);

    const certificate = Certificate.fromCertificateArn(
      this,
      "QinCertificate",
      CERTIFICATE_ARN
    );

    // CloudFront Function to append .html to requests without extensions
    const urlRewriteFunction = new CloudFrontFunction(
      this,
      "QinUrlRewrite",
      {
        code: FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.endsWith('/')) {
    request.uri += 'index.html';
  } else if (!uri.includes('.')) {
    request.uri += '.html';
  }
  return request;
}
`),
      }
    );

    const qinDistribution = new Distribution(this, "QinCloudfront", {
      domainNames: [QIN_DOMAIN],
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessIdentity(qinBucket, {
          originAccessIdentity: qinAOI,
        }),
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          {
            function: urlRewriteFunction,
            eventType: FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      defaultRootObject: "index.html",
      certificate,
    });

    // Create Lambda function for CloudFront cache invalidation
    const invalidateCloudfrontFunction = new NodejsFunction(
      this,
      "invalidate-cloudfront",
      {
        entry: "./lib/invalidate-cloudfront.function.ts",
        environment: {
          DISTRIBUTION_ID: qinDistribution.distributionId,
        },
      }
    );

    // Grant Lambda permission to create CloudFront invalidations
    invalidateCloudfrontFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["cloudfront:CreateInvalidation"],
        resources: [
          `arn:aws:cloudfront::${this.account}:distribution/${qinDistribution.distributionId}`,
        ],
      })
    );

    // Set up S3 event notification to trigger Lambda on object creation/modification
    qinBucket.addEventNotification(
      EventType.OBJECT_CREATED,
      new LambdaDestination(invalidateCloudfrontFunction)
    );

    qinBucket.addEventNotification(
      EventType.OBJECT_REMOVED,
      new LambdaDestination(invalidateCloudfrontFunction)
    );

    new CfnOutput(this, "QinDistributionId", {
      value: qinDistribution.distributionId,
      description: "Qin CloudFront Distribution ID",
    });

    new CfnOutput(this, "QinDistributionDomain", {
      value: qinDistribution.distributionDomainName,
      description: "Qin CloudFront Domain (use this for DNS CNAME record)",
    });

    new CfnOutput(this, "QinBucketName", {
      value: qinBucket.bucketName,
      description: "Qin S3 Bucket Name (use this for GitHub secrets)",
    });
  }
}
