import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const client = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,x-api-key,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Cache-Control": "max-age=30",
};

const DEFAULT_RESPONSE = {
  state: "dreaming",
  lastPing: null,
  currentTask: null,
  birth: "2026-01-30T06:00:00Z",
};

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    const result = await client.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: "PULSE" },
          sk: { S: "current" },
        },
      })
    );

    if (!result.Item) {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify(DEFAULT_RESPONSE),
      };
    }

    const item = unmarshall(result.Item);

    // Remove internal DynamoDB fields from response
    const { pk, sk, ttl, ...pulseData } = item;

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify(pulseData),
    };
  } catch (error) {
    console.error("Error reading pulse:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Failed to read pulse data" }),
    };
  }
};
