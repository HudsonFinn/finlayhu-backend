import { Stack, StackProps, RemovalPolicy, Duration } from "aws-cdk-lib";
import {
  Table,
  AttributeType,
  BillingMode,
} from "aws-cdk-lib/aws-dynamodb";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import {
  LambdaRestApi,
  LambdaIntegration,
  ApiKey,
  UsagePlan,
  Period,
  Cors,
} from "aws-cdk-lib/aws-apigateway";
import { Construct } from "constructs";

export class PulseStack extends Stack {
  public readonly pulseApi: LambdaRestApi;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // DynamoDB table for pulse data
    const pulseTable = new Table(this, "QinPulse", {
      tableName: "QinPulse",
      partitionKey: { name: "pk", type: AttributeType.STRING },
      sortKey: { name: "sk", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      timeToLiveAttribute: "ttl",
    });

    // Write Lambda (POST /pulse)
    const writePulseFunction = new NodejsFunction(this, "write-pulse", {
      entry: "./lib/write-pulse.function.ts",
      timeout: Duration.seconds(5),
      environment: {
        TABLE_NAME: pulseTable.tableName,
      },
    });
    pulseTable.grantWriteData(writePulseFunction);

    // Read Lambda (GET /pulse)
    const readPulseFunction = new NodejsFunction(this, "read-pulse", {
      entry: "./lib/read-pulse.function.ts",
      timeout: Duration.seconds(5),
      environment: {
        TABLE_NAME: pulseTable.tableName,
      },
    });
    pulseTable.grantReadData(readPulseFunction);

    // API Gateway
    this.pulseApi = new LambdaRestApi(this, "pulse-api", {
      handler: readPulseFunction,
      proxy: false,
      deployOptions: {
        throttlingRateLimit: 10,
        throttlingBurstLimit: 20,
      },
      defaultCorsPreflightOptions: {
        allowOrigins: Cors.ALL_ORIGINS,
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: [
          "Content-Type",
          "x-api-key",
          "Authorization",
        ],
      },
    });

    // /api/pulse resource
    const apiResource = this.pulseApi.root.addResource("api");
    const pulseResource = apiResource.addResource("pulse");

    // GET /api/pulse — public, no API key
    pulseResource.addMethod("GET");

    // POST /api/pulse — requires API key
    pulseResource.addMethod(
      "POST",
      new LambdaIntegration(writePulseFunction),
      { apiKeyRequired: true }
    );

    // API Key for Qin's POST requests
    const apiKey = new ApiKey(this, "QinPulseApiKey", {
      apiKeyName: "qin-pulse-key",
      description: "API key for Qin to send pulse pings",
    });

    const usagePlan = new UsagePlan(this, "PulseUsagePlan", {
      name: "QinPulse",
      throttle: { rateLimit: 10, burstLimit: 20 },
      quota: { limit: 1000, period: Period.DAY },
    });

    usagePlan.addApiKey(apiKey);
    usagePlan.addApiStage({ stage: this.pulseApi.deploymentStage });
  }
}
