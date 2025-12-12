import { Stack, StackProps, RemovalPolicy, Duration } from "aws-cdk-lib";
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

    const saveOuraDataRole = new Role(this, "save-oura-data-role", {
      roleName: "save-oura-data-role",
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    });

    saveOuraDataRole.addToPolicy(
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

    const saveOuraDataFunction = new NodejsFunction(this, "save-oura-data", {
      entry: "./lib/save-oura-data.function.ts",
      role: saveOuraDataRole,
      timeout: Duration.seconds(10),
      environment: {
        BUCKET_NAME: this.ouraDataBucket.bucketName,
      },
    });

    const parametersAndSecretsExtension = LayerVersion.fromLayerVersionArn(
      this,
      "ParametersAndSecretsLambdaExtension",
      "arn:aws:lambda:us-east-1:177933569100:layer:AWS-Parameters-and-Secrets-Lambda-Extension:20"
    );

    saveOuraDataFunction.addLayers(parametersAndSecretsExtension);

    // Grant Lambda function write permissions to S3 bucket
    this.ouraDataBucket.grantReadWrite(saveOuraDataFunction);

    // Create EventBridge rule to trigger Lambda hourly
    const hourlyRule = new Rule(this, "HourlyOuraDataRule", {
      schedule: Schedule.cron({
        minute: "0",
        hour: "*",
      }),
      description:
        "Trigger Oura data collection hourly at the top of each hour",
    });

    // Add Lambda function as target for the EventBridge rule
    hourlyRule.addTarget(new LambdaFunction(saveOuraDataFunction));

    const s3AOI = new OriginAccessIdentity(this, "s3AOI");
    this.ouraDataBucket.grantRead(s3AOI);
  }
}
