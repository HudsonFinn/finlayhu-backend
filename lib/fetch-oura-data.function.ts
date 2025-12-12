import { APIGatewayEvent, APIGatewayProxyResult, Context } from "aws-lambda";
import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

const s3Client = new S3Client({ region: "us-east-1" });

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

export const handler = async (
  event: APIGatewayEvent,
  _context: Context
): Promise<APIGatewayProxyResult> => {
  try {
    // Extract date from path parameter or use today's date
    let date: string;

    if (event.pathParameters && event.pathParameters.date) {
      date = event.pathParameters.date;

      // Validate date format (YYYY-MM-DD)
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(date)) {
        return {
          statusCode: 400,
          headers: {
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "OPTIONS,GET",
          },
          body: JSON.stringify({
            message: "Invalid date format. Use YYYY-MM-DD format (e.g., 2025-08-15)",
          }),
        };
      }
    } else {
      // Use today's date
      date = new Date().toISOString().split("T")[0];
    }

    const data = await fetchFromS3(date);

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS,GET",
      },
      body: JSON.stringify({
        date,
        data,
      }),
    };
  } catch (error: any) {
    return {
      statusCode: error.message.includes("No data found") ? 404 : 500,
      headers: {
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS,GET",
      },
      body: JSON.stringify({
        message: error.message || "Failed to fetch Oura data",
      }),
    };
  }
};
