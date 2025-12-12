import { APIGatewayEvent, APIGatewayProxyResult, Context } from "aws-lambda";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const s3Client = new S3Client({ region: "us-east-1" });

const fetchFromS3 = async (date: string): Promise<any> => {
  const bucketName = process.env.BUCKET_NAME;
  if (!bucketName) {
    throw new Error("BUCKET_NAME environment variable is not set");
  }

  const fileName = `oura-data-${date}.json`;

  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: fileName,
    });

    const response = await s3Client.send(command);

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
