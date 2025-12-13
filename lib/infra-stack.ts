import {
  RemovalPolicy,
  Stack,
  StackProps,
  Duration,
  CfnOutput,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import { Bucket, EventType } from "aws-cdk-lib/aws-s3";
import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";
import {
  Distribution,
  OriginAccessIdentity,
  CachePolicy,
  CacheHeaderBehavior,
  CacheQueryStringBehavior,
  AllowedMethods,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LambdaRestApi } from "aws-cdk-lib/aws-apigateway";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";

const DOMAIN_NAME = "fhudson.com";
const SUB_DOMAIN_NAME = "*.fhudson.com";
const CERTIFICATE_ARN =
  "arn:aws:acm:us-east-1:457471291771:certificate/6289263c-411b-4981-9c2a-a872d19fe0e7";

interface InfraStackProps extends StackProps {
  ouraDataBucket: Bucket;
}

export class InfraStack extends Stack {
  constructor(scope: Construct, id: string, props: InfraStackProps) {
    super(scope, id, props);

    const s3Bucket = new Bucket(this, "ImportBucket", {
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const lambdaFunction = new NodejsFunction(this, "get-qotd", {
      entry: "./lib/get-qotd.function.ts",
    });

    const quoteOfTheDayAPI = new LambdaRestApi(this, "get-qotd-api", {
      handler: lambdaFunction,
    });

    // Create Lambda function to fetch Oura data from S3
    const fetchOuraDataFunction = new NodejsFunction(this, "fetch-oura-data", {
      entry: "./lib/fetch-oura-data.function.ts",
      environment: {
        BUCKET_NAME: props.ouraDataBucket.bucketName,
      },
    });

    // Grant read permissions to the Oura data bucket
    props.ouraDataBucket.grantRead(fetchOuraDataFunction);

    // Create API Gateway for Oura data with proxy integration
    const ouraDataAPI = new LambdaRestApi(this, "fetch-oura-data-api", {
      handler: fetchOuraDataFunction,
      proxy: false,
    });

    // Add root resource for current day's data
    const ouraRoot = ouraDataAPI.root.addResource("api").addResource("oura");
    ouraRoot.addMethod("GET");

    // Add date parameter resource for specific dates
    const ouraDate = ouraRoot.addResource("{date}");
    ouraDate.addMethod("GET");

    const s3AOI = new OriginAccessIdentity(this, "s3AOI");
    s3Bucket.grantRead(s3AOI);

    const certificate = Certificate.fromCertificateArn(
      this,
      "StaticSiteCertificate",
      CERTIFICATE_ARN
    );

    // Custom cache policy for Oura API (1 hour TTL)
    const ouraCachePolicy = new CachePolicy(this, "OuraCachePolicy", {
      cachePolicyName: "OuraDataCachePolicy",
      comment: "Cache policy for Oura API with 1 hour TTL",
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.hours(1),
      maxTtl: Duration.hours(1),
      headerBehavior: CacheHeaderBehavior.allowList(
        "Access-Control-Allow-Origin",
        "Access-Control-Allow-Methods",
        "Access-Control-Allow-Headers"
      ),
      queryStringBehavior: CacheQueryStringBehavior.all(),
    });

    // Custom cache policy for QOTD API (24 hour TTL)
    const qotdCachePolicy = new CachePolicy(this, "QOTDCachePolicy", {
      cachePolicyName: "QOTDCachePolicy",
      comment: "Cache policy for Quote of the Day API with 24 hour TTL",
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.hours(24),
      maxTtl: Duration.hours(24),
      headerBehavior: CacheHeaderBehavior.allowList(
        "Access-Control-Allow-Origin",
        "Access-Control-Allow-Methods",
        "Access-Control-Allow-Headers"
      ),
      queryStringBehavior: CacheQueryStringBehavior.all(),
    });

    const cloudfront = new Distribution(this, "PersonalSiteCloudfront", {
      domainNames: [DOMAIN_NAME, SUB_DOMAIN_NAME],
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessIdentity(s3Bucket, {
          originAccessIdentity: s3AOI,
        }),
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: "index.html",
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: "/index.html",
        },
        {
          httpStatus: 403,
          responseHttpStatus: 403,
          responsePagePath: "/index.html",
        },
      ],
      additionalBehaviors: {
        "/api/qotd": {
          origin: new HttpOrigin(
            `${quoteOfTheDayAPI.restApiId}.execute-api.${this.region}.${this.urlSuffix}`,
            { originPath: `/${quoteOfTheDayAPI.deploymentStage.stageName}` }
          ),
          cachePolicy: qotdCachePolicy,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        },
        "/api/oura*": {
          origin: new HttpOrigin(
            `${ouraDataAPI.restApiId}.execute-api.${this.region}.${this.urlSuffix}`,
            { originPath: `/${ouraDataAPI.deploymentStage.stageName}` }
          ),
          cachePolicy: ouraCachePolicy,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        },
      },
      certificate,
    });

    // Create Lambda function for CloudFront cache invalidation
    const invalidateCloudfrontFunction = new NodejsFunction(
      this,
      "invalidate-cloudfront",
      {
        entry: "./lib/invalidate-cloudfront.function.ts",
        environment: {
          DISTRIBUTION_ID: cloudfront.distributionId,
        },
      }
    );

    // Grant Lambda permission to create CloudFront invalidations
    invalidateCloudfrontFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["cloudfront:CreateInvalidation"],
        resources: [
          `arn:aws:cloudfront::${this.account}:distribution/${cloudfront.distributionId}`,
        ],
      })
    );

    // Set up S3 event notification to trigger Lambda on object creation/modification
    s3Bucket.addEventNotification(
      EventType.OBJECT_CREATED,
      new LambdaDestination(invalidateCloudfrontFunction)
    );

    s3Bucket.addEventNotification(
      EventType.OBJECT_REMOVED,
      new LambdaDestination(invalidateCloudfrontFunction)
    );

    // Output the CloudFront distribution ID for easy reference
    new CfnOutput(this, "CloudFrontDistributionId", {
      value: cloudfront.distributionId,
      description: "CloudFront Distribution ID",
      exportName: "CloudFrontDistributionId",
    });

    // Output the CloudFront domain name
    new CfnOutput(this, "CloudFrontDomainName", {
      value: cloudfront.distributionDomainName,
      description: "CloudFront Distribution Domain Name",
    });
  }
}
