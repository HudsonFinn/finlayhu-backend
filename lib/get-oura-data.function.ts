import { APIGatewayEvent, APIGatewayProxyResult, Context } from "aws-lambda";
import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  queryByDate,
  transformOuraItemsToApiResponse,
  queryOuraDateRange,
} from "./dynamodb-helper";
import { OuraApiResponse } from "./database-types";

const s3Client = new S3Client({ region: "us-east-1" });

const MAX_RANGE_DAYS = 90;

function isValidDate(dateString: string): boolean {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateString)) return false;
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date.getTime());
}

function daysBetween(start: string, end: string): number {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const diffTime = endDate.getTime() - startDate.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

const fetchFromDynamoDB = async (date: string): Promise<any> => {
  const items = await queryByDate("OURA", date);

  if (items.length === 0) {
    throw new Error(`No data found for date: ${date}`);
  }

  return transformOuraItemsToApiResponse(items);
};

const fetchFromS3 = async (date: string): Promise<any> => {
  const bucketName = process.env.BUCKET_NAME;
  if (!bucketName) {
    throw new Error("BUCKET_NAME environment variable is not set");
  }

  // List all files for the given date
  const prefix = `oura-data-${date}-`;

  try {
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
    });

    const listResponse = await s3Client.send(listCommand);

    if (!listResponse.Contents || listResponse.Contents.length === 0) {
      throw new Error(`No data found for date: ${date}`);
    }

    // Sort files by key name (chronologically due to YYYY-MM-DD-HH format)
    // and get the most recent one
    const sortedFiles = listResponse.Contents.sort((a, b) => {
      const keyA = a.Key || "";
      const keyB = b.Key || "";
      return keyB.localeCompare(keyA);
    });

    const mostRecentFile = sortedFiles[0].Key;

    if (!mostRecentFile) {
      throw new Error(`No data found for date: ${date}`);
    }

    // Fetch the most recent file
    const getCommand = new GetObjectCommand({
      Bucket: bucketName,
      Key: mostRecentFile,
    });

    const response = await s3Client.send(getCommand);

    if (!response.Body) {
      throw new Error("No data found in S3 object");
    }

    const bodyContents = await response.Body.transformToString();
    return JSON.parse(bodyContents);
  } catch (error: any) {
    if (error.name === "NoSuchKey") {
      throw new Error(`No data found for date: ${date}`);
    }
    throw error;
  }
};

async function fetchDateRange(
  startDate: string,
  endDate: string
): Promise<Record<string, OuraApiResponse>> {
  const items = await queryOuraDateRange(startDate, endDate);

  // Group items by date
  const dateGroups: Record<string, Record<string, unknown>[]> = {};
  for (const item of items) {
    const date = item.date as string;
    if (!dateGroups[date]) {
      dateGroups[date] = [];
    }
    dateGroups[date].push(item);
  }

  // Transform each date's items to API response format
  const result: Record<string, OuraApiResponse> = {};
  for (const [date, dateItems] of Object.entries(dateGroups)) {
    result[date] = transformOuraItemsToApiResponse(dateItems);
  }

  return result;
}

export const handler = async (
  event: APIGatewayEvent,
  _context: Context
): Promise<APIGatewayProxyResult> => {
  const corsHeaders = {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "OPTIONS,GET",
  };

  try {
    // Check for date range query parameters
    const startParam = event.queryStringParameters?.start;
    const endParam = event.queryStringParameters?.end;

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
      const dates = await fetchDateRange(startParam, endParam);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          start: startParam,
          end: endParam,
          dates,
        }),
      };
    }

    // Handle single date query (existing behavior)
    let date: string;

    if (event.pathParameters && event.pathParameters.date) {
      date = event.pathParameters.date;

      // Validate date format (YYYY-MM-DD)
      if (!isValidDate(date)) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            message: "Invalid date format. Use YYYY-MM-DD format (e.g., 2026-02-07)",
          }),
        };
      }
    } else {
      // Use today's date
      date = new Date().toISOString().split("T")[0];
    }

    // Try DynamoDB first, fall back to S3
    let data: any;
    const tableName = process.env.TABLE_NAME;

    if (tableName) {
      try {
        data = await fetchFromDynamoDB(date);
        console.log(`Fetched from DynamoDB: ${date}`);
      } catch (error) {
        console.warn("DynamoDB read failed, falling back to S3:", error);
        data = await fetchFromS3(date);
      }
    } else {
      data = await fetchFromS3(date);
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        date,
        data,
      }),
    };
  } catch (error: any) {
    return {
      statusCode: error.message.includes("No data found") ? 404 : 500,
      headers: corsHeaders,
      body: JSON.stringify({
        message: error.message || "Failed to fetch Oura data",
      }),
    };
  }
};
