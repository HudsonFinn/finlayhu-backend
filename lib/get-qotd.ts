import { Construct } from "constructs";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LambdaRestApi } from "aws-cdk-lib/aws-apigateway";

export class QuoteOfTheDayAPI extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    const lambdaFunction = new NodejsFunction(this, "function");
    new LambdaRestApi(this, "apigw", {
      handler: lambdaFunction,
    });
  }
}
