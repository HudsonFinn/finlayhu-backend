import { Fn, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { QuoteOfTheDayAPI } from "./get-qotd";
import {
  BlockPublicAccess,
  Bucket,
  BucketAccessControl,
  CorsRule,
  HttpMethods,
} from "aws-cdk-lib/aws-s3";
import {
  CloudFrontAllowedMethods,
  CloudFrontWebDistribution,
  Distribution,
  OriginAccessIdentity,
  OriginProtocolPolicy,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { HttpOrigin, S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LambdaRestApi } from "aws-cdk-lib/aws-apigateway";
import path = require("path");
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";

const DOMAIN_NAME = "fhudson.com";
const SUB_DOMAIN_NAME = "*.fhudson.com";
const CERTIFICATE_ARN =
  "arn:aws:acm:us-east-1:457471291771:certificate/6289263c-411b-4981-9c2a-a872d19fe0e7";

export class InfraStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
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

    const s3AOI = new OriginAccessIdentity(this, "s3AOI");
    s3Bucket.grantRead(s3AOI);

    const certificate = Certificate.fromCertificateArn(
      this,
      "StaticSiteCertificate",
      CERTIFICATE_ARN
    );

    const cloudfront = new Distribution(this, "PersonalSiteCloudfront", {
      domainNames: [DOMAIN_NAME, SUB_DOMAIN_NAME],
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessIdentity(s3Bucket, {
          originAccessIdentity: s3AOI,
        }),
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
        },
      },
      certificate,
    });
  }
}
