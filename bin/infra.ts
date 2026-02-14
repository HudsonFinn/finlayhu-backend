#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { InfraStack } from "../lib/infra-stack";
import { OuraStack } from "../lib/oura-stack";
import { StravaStack } from "../lib/strava-stack";
import { ChalkboardStack } from "../lib/chalkboard-stack";
import { QinStack } from "../lib/qin-stack";
import { DatabaseStack } from "../lib/database-stack";

const app = new cdk.App();
const databaseStack = new DatabaseStack(app, "DatabaseStack", {});
const ouraStack = new OuraStack(app, "OuraStack", {
  healthDataTable: databaseStack.healthDataTable,
});
const stravaStack = new StravaStack(app, "StravaStack", {
  healthDataTable: databaseStack.healthDataTable,
});
new InfraStack(app, "InfraStack", {
  ouraDataBucket: ouraStack.ouraDataBucket,
  stravaDataBucket: stravaStack.stravaDataBucket,
  healthDataTable: databaseStack.healthDataTable,
});
new ChalkboardStack(app, "ChalkboardStack", {});
new QinStack(app, "QinStack", {});
