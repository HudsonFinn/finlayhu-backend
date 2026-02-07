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
import { Table } from "aws-cdk-lib/aws-dynamodb";

const DOMAIN_NAME = "fhudson.com";
const SUB_DOMAIN_NAME = "*.fhudson.com";
const CERTIFICATE_ARN =
  "arn:aws:acm:us-east-1:457471291771:certificate/6289263c-411b-4981-9c2a-a872d19fe0e7";

interface InfraStackProps extends StackProps {
  ouraDataBucket: Bucket;
  stravaDataBucket: Bucket;
  healthDataTable?: Table;
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
      deployOptions: {
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
      },
    });

    // Create Lambda function to fetch Oura data from S3
    const fetchOuraDataFunction = new NodejsFunction(this, "get-oura-data", {
      entry: "./lib/get-oura-data.function.ts",
      environment: {
        BUCKET_NAME: props.ouraDataBucket.bucketName,
      },
    });

    // Grant read permissions to the Oura data bucket
    props.ouraDataBucket.grantRead(fetchOuraDataFunction);

    // Grant DynamoDB read permissions if table is provided
    if (props.healthDataTable) {
      fetchOuraDataFunction.addEnvironment(
        "TABLE_NAME",
        props.healthDataTable.tableName
      );
      props.healthDataTable.grantReadData(fetchOuraDataFunction);
    }

    // Create API Gateway for Oura data with proxy integration
    const ouraDataAPI = new LambdaRestApi(this, "get-oura-data-api", {
      handler: fetchOuraDataFunction,
      proxy: false,
      deployOptions: {
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
      },
    });

    // Add root resource for current day's data
    const ouraRoot = ouraDataAPI.root.addResource("api").addResource("oura");
    ouraRoot.addMethod("GET");

    // Add date parameter resource for specific dates
    const ouraDate = ouraRoot.addResource("{date}");
    ouraDate.addMethod("GET");

    // Create Lambda function to fetch Strava data from S3
    const fetchStravaDataFunction = new NodejsFunction(
      this,
      "get-strava-data",
      {
        entry: "./lib/get-strava.function.ts",
        environment: {
          BUCKET_NAME: props.stravaDataBucket.bucketName,
        },
      }
    );

    // Grant read permissions to the Strava data bucket
    props.stravaDataBucket.grantRead(fetchStravaDataFunction);

    // Grant DynamoDB read permissions if table is provided
    if (props.healthDataTable) {
      fetchStravaDataFunction.addEnvironment(
        "TABLE_NAME",
        props.healthDataTable.tableName
      );
      props.healthDataTable.grantReadData(fetchStravaDataFunction);
    }

    // Create API Gateway for Strava data with custom resources
    const stravaDataAPI = new LambdaRestApi(this, "get-strava-data-api", {
      handler: fetchStravaDataFunction,
      proxy: false,
      deployOptions: {
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
      },
    });

    // Add root resource for current day's data
    const stravaRoot = stravaDataAPI.root
      .addResource("api")
      .addResource("strava");
    stravaRoot.addMethod("GET");

    // Add date parameter resource for specific dates
    const stravaDate = stravaRoot.addResource("{date}");
    stravaDate.addMethod("GET");

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

    // Custom cache policy for Strava API (30 minute TTL)
    const stravaCachePolicy = new CachePolicy(this, "StravaCachePolicy", {
      cachePolicyName: "StravaDataCachePolicy",
      comment: "Cache policy for Strava API with 30 minute TTL",
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.minutes(30),
      maxTtl: Duration.minutes(30),
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
        "/api/strava*": {
          origin: new HttpOrigin(
            `${stravaDataAPI.restApiId}.execute-api.${this.region}.${this.urlSuffix}`,
            { originPath: `/${stravaDataAPI.deploymentStage.stageName}` }
          ),
          cachePolicy: stravaCachePolicy,
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
