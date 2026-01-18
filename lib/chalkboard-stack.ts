import { RemovalPolicy, Stack, StackProps, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Bucket, EventType } from "aws-cdk-lib/aws-s3";
import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";
import {
  Distribution,
  OriginAccessIdentity,
  CachePolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";

const CHALKBOARD_DOMAIN = "chalkboard.fhudson.com";
const CERTIFICATE_ARN =
  "arn:aws:acm:us-east-1:457471291771:certificate/6289263c-411b-4981-9c2a-a872d19fe0e7";

export class ChalkboardStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const chalkboardBucket = new Bucket(this, "ChalkboardBucket", {
      bucketName: "chalkboard-ui",
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const chalkboardAOI = new OriginAccessIdentity(this, "ChalkboardAOI");
    chalkboardBucket.grantRead(chalkboardAOI);

    const certificate = Certificate.fromCertificateArn(
      this,
      "ChalkboardCertificate",
      CERTIFICATE_ARN
    );

    const chalkboardDistribution = new Distribution(
      this,
      "ChalkboardCloudfront",
      {
        domainNames: [CHALKBOARD_DOMAIN],
        defaultBehavior: {
          origin: S3BucketOrigin.withOriginAccessIdentity(chalkboardBucket, {
            originAccessIdentity: chalkboardAOI,
          }),
          cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        },
        defaultRootObject: "index.html",
        errorResponses: [
          {
            httpStatus: 404,
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
          },
          {
            httpStatus: 403,
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
          },
        ],
        certificate,
      }
    );

    // Create Lambda function for CloudFront cache invalidation
    const invalidateCloudfrontFunction = new NodejsFunction(
      this,
      "invalidate-cloudfront",
      {
        entry: "./lib/invalidate-cloudfront.function.ts",
        environment: {
          DISTRIBUTION_ID: chalkboardDistribution.distributionId,
        },
      }
    );

    // Grant Lambda permission to create CloudFront invalidations
    invalidateCloudfrontFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["cloudfront:CreateInvalidation"],
        resources: [
          `arn:aws:cloudfront::${this.account}:distribution/${chalkboardDistribution.distributionId}`,
        ],
      })
    );

    // Set up S3 event notification to trigger Lambda on object creation/modification
    chalkboardBucket.addEventNotification(
      EventType.OBJECT_CREATED,
      new LambdaDestination(invalidateCloudfrontFunction)
    );

    chalkboardBucket.addEventNotification(
      EventType.OBJECT_REMOVED,
      new LambdaDestination(invalidateCloudfrontFunction)
    );

    new CfnOutput(this, "ChalkboardDistributionId", {
      value: chalkboardDistribution.distributionId,
      description: "Chalkboard CloudFront Distribution ID",
    });

    new CfnOutput(this, "ChalkboardDistributionDomain", {
      value: chalkboardDistribution.distributionDomainName,
      description:
        "Chalkboard CloudFront Domain (use this for DNS CNAME record)",
    });
  }
}
