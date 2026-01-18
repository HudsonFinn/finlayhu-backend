#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { InfraStack } from "../lib/infra-stack";
import { OuraStack } from "../lib/oura-stack";
import { ChalkboardStack } from "../lib/chalkboard-stack";

const app = new cdk.App();
const ouraStack = new OuraStack(app, "OuraStack", {});
new InfraStack(app, "InfraStack", {
  ouraDataBucket: ouraStack.ouraDataBucket,
});
new ChalkboardStack(app, "ChalkboardStack", {});
