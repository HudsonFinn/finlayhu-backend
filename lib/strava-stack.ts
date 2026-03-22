import { Stack, StackProps, RemovalPolicy, Duration } from "aws-cdk-lib";
import { Table } from "aws-cdk-lib/aws-dynamodb";
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

interface StravaStackProps extends StackProps {
  healthDataTable?: Table;
}

export class StravaStack extends Stack {
  public readonly stravaDataBucket: Bucket;

  constructor(scope: Construct, id: string, props?: StravaStackProps) {
    super(scope, id, props);

    this.stravaDataBucket = new Bucket(this, "StravaData", {
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const syncStravaDataRole = new Role(this, "sync-strava-role", {
      roleName: "sync-strava-role",
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
    });

    syncStravaDataRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "ssm:GetParameter",
          "secretsmanager:GetSecretValue",
          "secretsmanager:UpdateSecret",
          "kms:Decrypt",
        ],
        resources: ["*"],
      })
    );

    const syncStravaFunction = new NodejsFunction(this, "sync-strava", {
      entry: "./lib/sync-strava.function.ts",
      role: syncStravaDataRole,
      timeout: Duration.seconds(30),
      environment: {
        BUCKET_NAME: this.stravaDataBucket.bucketName,
        STRAVA_SECRETS_ARN:
          "arn:aws:secretsmanager:us-east-1:457471291771:secret:STRAVA_SECRETS-IpXAv6",
      },
    });

    const parametersAndSecretsExtension = LayerVersion.fromLayerVersionArn(
      this,
      "ParametersAndSecretsLambdaExtension",
      "arn:aws:lambda:us-east-1:177933569100:layer:AWS-Parameters-and-Secrets-Lambda-Extension:20"
    );

    syncStravaFunction.addLayers(parametersAndSecretsExtension);

    // Grant Lambda function read/write permissions to S3 bucket
    this.stravaDataBucket.grantReadWrite(syncStravaFunction);

    // Grant DynamoDB write permissions if table is provided
    if (props?.healthDataTable) {
      syncStravaFunction.addEnvironment(
        "TABLE_NAME",
        props.healthDataTable.tableName
      );
      props.healthDataTable.grantWriteData(syncStravaFunction);
    }

    // Create EventBridge rule to trigger Lambda hourly
    const hourlyRule = new Rule(this, "HourlyStravaDataRule", {
      schedule: Schedule.cron({
        minute: "0",
        hour: "*",
      }),
      description:
        "Trigger Strava data collection hourly at the top of each hour",
    });

    // Add Lambda function as target for the EventBridge rule
    hourlyRule.addTarget(new LambdaFunction(syncStravaFunction));
  }
}
