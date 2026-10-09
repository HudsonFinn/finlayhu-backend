import { RemovalPolicy, Stack, StackProps, CfnOutput } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Bucket, EventType } from "aws-cdk-lib/aws-s3";
import { LambdaDestination } from "aws-cdk-lib/aws-s3-notifications";
import {
  AccessLevel,
  Distribution,
  CachePolicy,
  OriginRequestPolicy,
  AllowedMethods,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LambdaRestApi } from "aws-cdk-lib/aws-apigateway";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Table } from "aws-cdk-lib/aws-dynamodb";

const DOMAIN_NAME = "fhudson.com";
const SUB_DOMAIN_NAME = "*.fhudson.com";
const CERTIFICATE_ARN =
  "arn:aws:acm:us-east-1:457471291771:certificate/6289263c-411b-4981-9c2a-a872d19fe0e7";
// Created by CloudFront when the distribution moved to a flat-rate pricing plan;
// the plan requires a web ACL, so it must stay attached
const WEB_ACL_ARN =
  "arn:aws:wafv2:us-east-1:457471291771:global/webacl/CreatedByCloudFront-fa0a6908/10a9d705-bfc1-4a1b-a0c9-8e703bc0c14a";

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
      runtime: Runtime.NODEJS_22_X,
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
      runtime: Runtime.NODEJS_22_X,
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
        runtime: Runtime.NODEJS_22_X,
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

    const certificate = Certificate.fromCertificateArn(
      this,
      "StaticSiteCertificate",
      CERTIFICATE_ARN
    );

    // The site is a single-page app: every page path serves index.html with a 200, and the app
    // routes in the browser. Done on the site's behaviour only, not with distribution-wide error
    // responses, so /api/* keeps its real status codes and JSON error bodies. Paths with a file
    // extension (assets, favicons) go to S3 untouched, so a missing file is a real 404.
    const spaRewrite = new CloudFrontFunction(this, "SpaRewrite", {
      runtime: FunctionRuntime.JS_2_0,
      comment: "Serve index.html for page paths (no file extension)",
      code: FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var last = request.uri.split('/').pop();
  if (last.indexOf('.') === -1) request.uri = '/index.html';
  return request;
}`),
    });

    const cloudfront = new Distribution(this, "PersonalSiteCloudfront", {
      domainNames: [DOMAIN_NAME, SUB_DOMAIN_NAME],
      webAclId: WEB_ACL_ARN,
      defaultBehavior: {
        // LIST lets S3 answer a missing file with 404 rather than 403. Query strings aren't
        // forwarded to S3 (CACHING_OPTIMIZED), so this can't be used to list the bucket.
        origin: S3BucketOrigin.withOriginAccessControl(s3Bucket, {
          originAccessLevels: [AccessLevel.READ, AccessLevel.LIST],
        }),
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          { function: spaRewrite, eventType: FunctionEventType.VIEWER_REQUEST },
        ],
      },
      defaultRootObject: "index.html",
      additionalBehaviors: {
        "/api/qotd": {
          origin: new HttpOrigin(
            `${quoteOfTheDayAPI.restApiId}.execute-api.${this.region}.${this.urlSuffix}`,
            { originPath: `/${quoteOfTheDayAPI.deploymentStage.stageName}` }
          ),
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        },
        "/api/oura*": {
          origin: new HttpOrigin(
            `${ouraDataAPI.restApiId}.execute-api.${this.region}.${this.urlSuffix}`,
            { originPath: `/${ouraDataAPI.deploymentStage.stageName}` }
          ),
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        },
        "/api/strava*": {
          origin: new HttpOrigin(
            `${stravaDataAPI.restApiId}.execute-api.${this.region}.${this.urlSuffix}`,
            { originPath: `/${stravaDataAPI.deploymentStage.stageName}` }
          ),
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
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
        runtime: Runtime.NODEJS_22_X,
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
