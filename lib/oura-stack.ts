import { Stack, StackProps, RemovalPolicy } from "aws-cdk-lib";
import { LambdaRestApi } from "aws-cdk-lib/aws-apigateway";
import { OriginAccessIdentity } from "aws-cdk-lib/aws-cloudfront";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import {
  Effect,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { LayerVersion } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export class OuraStack extends Stack {
  public readonly ouraDataBucket: Bucket;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.ouraDataBucket = new Bucket(this, "OuraData", {
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const getOuraDataRole = new Role(this, "get-oura-data-role", {
      roleName: "get-oura-data-role",
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    });

    getOuraDataRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "ssm:GetParameter",
          "secretsmanager:GetSecretValue",
          "kms:Decrypt",
        ],
        resources: ["*"],
      })
    );

    const getOuraDataFunction = new NodejsFunction(this, "get-oura-data", {
      entry: "./lib/get-oura-data.function.ts",
      role: getOuraDataRole,
      environment: {
        BUCKET_NAME: this.ouraDataBucket.bucketName,
      },
    });

    const parametersAndSecretsExtension = LayerVersion.fromLayerVersionArn(
      this,
      "ParametersAndSecretsLambdaExtension",
      "arn:aws:lambda:us-east-1:177933569100:layer:AWS-Parameters-and-Secrets-Lambda-Extension:20"
    );

    getOuraDataFunction.addLayers(parametersAndSecretsExtension);

    // Grant Lambda function write permissions to S3 bucket
    this.ouraDataBucket.grantReadWrite(getOuraDataFunction);

    // Create EventBridge rule to trigger Lambda daily at 11:59 PM UTC
    const dailyRule = new Rule(this, "DailyOuraDataRule", {
      schedule: Schedule.cron({
        minute: "59",
        hour: "23",
      }),
      description: "Trigger Oura data collection daily at 11:59 PM UTC",
    });

    // Add Lambda function as target for the EventBridge rule
    dailyRule.addTarget(new LambdaFunction(getOuraDataFunction));

    const s3AOI = new OriginAccessIdentity(this, "s3AOI");
    this.ouraDataBucket.grantRead(s3AOI);
  }
}
