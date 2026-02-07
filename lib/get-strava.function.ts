import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { StravaDayData } from "./strava-types";
import {
  queryByDate,
  transformStravaItemsToApiResponse,
  queryStravaDateRange,
  queryStravaByType,
} from "./dynamodb-helper";
import { StravaSummary } from "./database-types";

const s3Client = new S3Client({ region: "us-east-1" });
const BUCKET_NAME = process.env.BUCKET_NAME!;

const MAX_RANGE_DAYS = 90;

function isValidDate(dateString: string): boolean {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateString)) return false;

  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date.getTime());
}

function getTodayDate(): string {
  return new Date().toISOString().split("T")[0];
}

function daysBetween(start: string, end: string): number {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const diffTime = endDate.getTime() - startDate.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

async function fetchFromDynamoDB(date: string): Promise<StravaDayData | null> {
  const items = await queryByDate("STRAVA", date);

  if (items.length === 0) {
    return null;
  }

  const result = transformStravaItemsToApiResponse(items);
  return result as unknown as StravaDayData;
}

async function getLatestDataForDate(
  date: string
): Promise<StravaDayData | null> {
  try {
    // List all files with the date prefix
    const prefix = `strava-data-${date}-`;
    const listCommand = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: prefix,
    });

    const listResponse = await s3Client.send(listCommand);

    if (!listResponse.Contents || listResponse.Contents.length === 0) {
      return null;
    }

    // Sort by key descending to get the most recent file
    const sortedFiles = listResponse.Contents.sort((a, b) =>
      (b.Key || "").localeCompare(a.Key || "")
    );

    const latestFile = sortedFiles[0];
    if (!latestFile.Key) {
      return null;
    }

    // Fetch the file content
    const getCommand = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: latestFile.Key,
    });

    const getResponse = await s3Client.send(getCommand);
    const bodyString = await getResponse.Body?.transformToString();

    if (!bodyString) {
      return null;
    }

    return JSON.parse(bodyString);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "NoSuchKey" || error.name === "NotFound")
    ) {
      return null;
    }
    throw error;
  }
}

interface StravaRangeActivity {
  id: number;
  name: string;
  type: string;
  date: string;
  distance: number;
  moving_time: number;
  total_elevation_gain: number;
  average_heartrate?: number;
  [key: string]: unknown;
}

interface StravaRangeResponse {
  start: string;
  end: string;
  activities: StravaRangeActivity[];
  summary: StravaSummary;
}

async function fetchDateRange(
  startDate: string,
  endDate: string,
  activityType?: string
): Promise<StravaRangeResponse> {
  // Query activities based on whether type filter is specified
  const items = activityType
    ? await queryStravaByType(activityType, startDate, endDate)
    : await queryStravaDateRange(startDate, endDate);

  // Extract activities from items and add date
  const activities: StravaRangeActivity[] = items.map((item) => {
    const data = item.data as Record<string, unknown>;
    return {
      ...data,
      date: item.date as string,
    } as StravaRangeActivity;
  });

  // Sort activities by date (newest first)
  activities.sort((a, b) => b.date.localeCompare(a.date));

  // Calculate aggregate summary
  const summary: StravaSummary = {
    total_distance: 0,
    total_moving_time: 0,
    total_elevation: 0,
    activity_count: activities.length,
    types: {},
  };

  for (const activity of activities) {
    summary.total_distance += activity.distance || 0;
    summary.total_moving_time += activity.moving_time || 0;
    summary.total_elevation += activity.total_elevation_gain || 0;
    const type = activity.type || "Unknown";
    summary.types[type] = (summary.types[type] || 0) + 1;
  }

  return {
    start: startDate,
    end: endDate,
    activities,
    summary,
  };
}

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const corsHeaders = {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
  };

  try {
    // Check for date range query parameters
    const startParam = event.queryStringParameters?.start;
    const endParam = event.queryStringParameters?.end;
    const typeParam = event.queryStringParameters?.type;

    // Handle date range query
    if (startParam || endParam) {
      // Both start and end are required for range queries
      if (!startParam || !endParam) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            error: "Both 'start' and 'end' query parameters are required for range queries",
          }),
        };
      }

      // Validate date formats
      if (!isValidDate(startParam) || !isValidDate(endParam)) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            error: "Invalid date format. Use YYYY-MM-DD format (e.g., 2026-02-07)",
          }),
        };
      }

      // Validate start <= end
      if (startParam > endParam) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            error: "Start date must be before or equal to end date",
          }),
        };
      }

      // Validate range doesn't exceed maximum
      const rangeDays = daysBetween(startParam, endParam);
      if (rangeDays > MAX_RANGE_DAYS) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            error: `Date range cannot exceed ${MAX_RANGE_DAYS} days. Requested: ${rangeDays} days`,
          }),
        };
      }

      // Fetch date range (DynamoDB only, no S3 fallback for ranges)
      const result = await fetchDateRange(startParam, endParam, typeParam);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(result),
      };
    }

    // Handle single date query (existing behavior)
    const dateParam = event.pathParameters?.date;
    const date = dateParam || getTodayDate();

    // Validate date format
    if (!isValidDate(date)) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Invalid date format. Use YYYY-MM-DD.",
        }),
      };
    }

    // Try DynamoDB first, fall back to S3
    let data: StravaDayData | null = null;
    const tableName = process.env.TABLE_NAME;

    if (tableName) {
      try {
        data = await fetchFromDynamoDB(date);
        if (data) {
          console.log(`Fetched from DynamoDB: ${date}`);
        }
      } catch (error) {
        console.warn("DynamoDB read failed, falling back to S3:", error);
      }
    }

    // Fall back to S3 if DynamoDB didn't return data
    if (!data) {
      data = await getLatestDataForDate(date);
    }

    if (!data) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({
          error: `No Strava data found for ${date}`,
          date,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(data),
    };
  } catch (error) {
    console.error("Error fetching Strava data:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "Failed to fetch Strava data",
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
