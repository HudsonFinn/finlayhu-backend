import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { StravaDayData } from "./strava-types";
import { queryByDate, transformStravaItemsToApiResponse } from "./dynamodb-helper";

const s3Client = new S3Client({ region: "us-east-1" });
const BUCKET_NAME = process.env.BUCKET_NAME!;

function isValidDate(dateString: string): boolean {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateString)) return false;

  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date.getTime());
}

function getTodayDate(): string {
  return new Date().toISOString().split("T")[0];
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

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const corsHeaders = {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
  };

  try {
    // Get date from path parameter or use today
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
