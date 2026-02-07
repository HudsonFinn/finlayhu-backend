import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  OuraApiResponse,
  OuraItemType,
  OuraDynamoDBItem,
  StravaDynamoDBActivityItem,
  StravaDynamoDBSummaryItem,
  StravaSummary,
  buildOuraPK,
  buildOuraSK,
  buildOuraGSI1PK,
  buildStravaPK,
  buildStravaActivitySK,
  buildStravaSummarySK,
  buildStravaGSI1PK,
  buildStravaGSI2PK,
  calculateTTL,
} from "./database-types";

const GSI1_INDEX_NAME = "GSI1";
const GSI2_INDEX_NAME = "GSI2";

const client = new DynamoDBClient({ region: "us-east-1" });
const docClient = DynamoDBDocumentClient.from(client);

/**
 * Recursively sanitize data to convert large numbers to strings.
 * Strava returns some IDs (e.g., segment effort IDs) that exceed Number.MAX_SAFE_INTEGER,
 * which causes DynamoDB SDK to throw an error.
 */
function sanitizeLargeNumbers(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === "number") {
    if (obj > Number.MAX_SAFE_INTEGER || obj < Number.MIN_SAFE_INTEGER) {
      return obj.toString();
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeLargeNumbers);
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = sanitizeLargeNumbers(value);
    }
    return result;
  }

  return obj;
}

function getTableName(): string {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) {
    throw new Error("TABLE_NAME environment variable is not set");
  }
  return tableName;
}

/**
 * Write/overwrite Oura data for a given date.
 * Creates 4 items (SLEEP, READINESS, ACTIVITY, WORKOUT), overwriting any existing data.
 */
export async function putOuraDayData(
  date: string,
  data: OuraApiResponse
): Promise<void> {
  const tableName = getTableName();
  const now = new Date().toISOString();
  const ttl = calculateTTL();

  const itemTypes: { type: OuraItemType; data: Record<string, unknown> }[] = [
    { type: "SLEEP", data: data.sleep },
    { type: "READINESS", data: data.readiness },
    { type: "ACTIVITY", data: data.activity },
    { type: "WORKOUT", data: data.workout },
  ];

  // Write each item (PutCommand overwrites existing items with same PK+SK)
  await Promise.all(
    itemTypes.map(async ({ type, data: itemData }) => {
      const item: OuraDynamoDBItem = {
        PK: buildOuraPK(date),
        SK: buildOuraSK(type),
        GSI1PK: buildOuraGSI1PK(type),
        GSI1SK: date,
        dataSource: "OURA",
        date,
        updated_at: now,
        ttl,
        itemType: type,
        data: itemData,
      };

      await docClient.send(
        new PutCommand({
          TableName: tableName,
          Item: item,
        })
      );
    })
  );
}

/**
 * Write a single Strava activity.
 * Uses activity ID in SK, so re-writing the same activity just overwrites.
 */
export async function putStravaActivity(
  date: string,
  activity: Record<string, unknown>
): Promise<void> {
  const tableName = getTableName();
  const now = new Date().toISOString();
  const ttl = calculateTTL();

  const activityId = activity.id as number;
  const activityType = (activity.type as string) || "Unknown";

  // Sanitize activity data to handle large numbers (e.g., segment effort IDs)
  const sanitizedActivity = sanitizeLargeNumbers(activity) as Record<string, unknown>;

  const item: StravaDynamoDBActivityItem = {
    PK: buildStravaPK(date),
    SK: buildStravaActivitySK(activityId),
    GSI1PK: buildStravaGSI1PK(),
    GSI1SK: date,
    GSI2PK: buildStravaGSI2PK(activityType),
    GSI2SK: date,
    dataSource: "STRAVA",
    date,
    updated_at: now,
    ttl,
    activityId,
    activityType,
    data: sanitizedActivity,
  };

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: item,
    })
  );
}

/**
 * Write/overwrite daily Strava summary.
 */
export async function putStravaSummary(
  date: string,
  summary: StravaSummary
): Promise<void> {
  const tableName = getTableName();
  const now = new Date().toISOString();
  const ttl = calculateTTL();

  const item: StravaDynamoDBSummaryItem = {
    PK: buildStravaPK(date),
    SK: buildStravaSummarySK(),
    dataSource: "STRAVA",
    date,
    updated_at: now,
    ttl,
    data: summary,
  };

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: item,
    })
  );
}

/**
 * Query all items for a given data source and date.
 */
export async function queryByDate(
  dataSource: "OURA" | "STRAVA",
  date: string
): Promise<Record<string, unknown>[]> {
  const tableName = getTableName();
  const pk = dataSource === "OURA" ? buildOuraPK(date) : buildStravaPK(date);

  const response = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: {
        ":pk": pk,
      },
    })
  );

  return (response.Items || []) as Record<string, unknown>[];
}

/**
 * Transform DynamoDB Oura items back to API response format.
 */
export function transformOuraItemsToApiResponse(
  items: Record<string, unknown>[]
): OuraApiResponse {
  const result: OuraApiResponse = {
    readiness: {},
    sleep: {},
    activity: {},
    workout: {},
  };

  for (const item of items) {
    const itemType = item.itemType as OuraItemType;
    const data = item.data as Record<string, unknown>;

    switch (itemType) {
      case "SLEEP":
        result.sleep = data;
        break;
      case "READINESS":
        result.readiness = data;
        break;
      case "ACTIVITY":
        result.activity = data;
        break;
      case "WORKOUT":
        result.workout = data;
        break;
    }
  }

  return result;
}

/**
 * Transform DynamoDB Strava items back to StravaDayData format.
 */
export function transformStravaItemsToApiResponse(
  items: Record<string, unknown>[]
): {
  date: string;
  fetched_at: string;
  activities: Record<string, unknown>[];
  summary: StravaSummary;
} {
  const activities: Record<string, unknown>[] = [];
  let summary: StravaSummary = {
    total_distance: 0,
    total_moving_time: 0,
    total_elevation: 0,
    activity_count: 0,
    types: {},
  };
  let date = "";
  let fetched_at = "";

  for (const item of items) {
    const sk = item.SK as string;

    if (sk.startsWith("ACTIVITY#")) {
      activities.push(item.data as Record<string, unknown>);
      if (!date) date = item.date as string;
      if (!fetched_at) fetched_at = item.updated_at as string;
    } else if (sk === "SUMMARY") {
      summary = item.data as StravaSummary;
      if (!date) date = item.date as string;
      if (!fetched_at) fetched_at = item.updated_at as string;
    }
  }

  return {
    date,
    fetched_at,
    activities,
    summary,
  };
}

/**
 * Query Oura data for a date range using GSI1.
 * Returns all items for each Oura item type within the date range.
 * Optionally filter by a specific item type.
 */
export async function queryOuraDateRange(
  startDate: string,
  endDate: string,
  itemType?: OuraItemType
): Promise<Record<string, unknown>[]> {
  const tableName = getTableName();
  const itemTypes: OuraItemType[] = itemType
    ? [itemType]
    : ["SLEEP", "READINESS", "ACTIVITY", "WORKOUT"];

  const results = await Promise.all(
    itemTypes.map(async (type) => {
      const response = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: GSI1_INDEX_NAME,
          KeyConditionExpression:
            "GSI1PK = :gsi1pk AND GSI1SK BETWEEN :start AND :end",
          ExpressionAttributeValues: {
            ":gsi1pk": buildOuraGSI1PK(type),
            ":start": startDate,
            ":end": endDate,
          },
        })
      );
      return response.Items || [];
    })
  );

  return results.flat() as Record<string, unknown>[];
}

/**
 * Query Strava activities for a date range using GSI1.
 * Returns all activity items within the date range.
 */
export async function queryStravaDateRange(
  startDate: string,
  endDate: string
): Promise<Record<string, unknown>[]> {
  const tableName = getTableName();

  const response = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: GSI1_INDEX_NAME,
      KeyConditionExpression:
        "GSI1PK = :gsi1pk AND GSI1SK BETWEEN :start AND :end",
      ExpressionAttributeValues: {
        ":gsi1pk": buildStravaGSI1PK(),
        ":start": startDate,
        ":end": endDate,
      },
    })
  );

  return (response.Items || []) as Record<string, unknown>[];
}

/**
 * Query Strava activities by type for a date range using GSI2.
 * Returns activities of a specific type (e.g., "Run", "Ride") within the date range.
 */
export async function queryStravaByType(
  activityType: string,
  startDate: string,
  endDate: string
): Promise<Record<string, unknown>[]> {
  const tableName = getTableName();

  const response = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: GSI2_INDEX_NAME,
      KeyConditionExpression:
        "GSI2PK = :gsi2pk AND GSI2SK BETWEEN :start AND :end",
      ExpressionAttributeValues: {
        ":gsi2pk": buildStravaGSI2PK(activityType),
        ":start": startDate,
        ":end": endDate,
      },
    })
  );

  return (response.Items || []) as Record<string, unknown>[];
}
