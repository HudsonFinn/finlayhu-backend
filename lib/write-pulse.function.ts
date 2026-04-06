import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

const client = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,x-api-key,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    const body = JSON.parse(event.body || "{}");
    const now = new Date().toISOString();
    const ttl = Math.floor(Date.now() / 1000) + 7 * 86400; // 7 days

    // Write current pulse state
    await client.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: marshall(
          {
            pk: "PULSE",
            sk: "current",
            state: body.state || "active",
            currentTask: body.currentTask || null,
            lastPing: now,
            sessionCount: body.sessionCount || 0,
            cronRuns: body.cronRuns || 0,
            todaySessions: body.todaySessions || 0,
            memoryDays: body.memoryDays || 0,
            totalPosts: body.totalPosts || 0,
            recentPosts: body.recentPosts || [],
            birth: body.birth || "2026-01-30T06:00:00Z",
            ttl,
          },
          { removeUndefinedValues: true }
        ),
      })
    );

    // Optionally write a ping history entry
    await client.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: marshall(
          {
            pk: "PULSE",
            sk: `ping#${now}`,
            state: body.state || "active",
            currentTask: body.currentTask || null,
            ttl, // Auto-expire after 7 days
          },
          { removeUndefinedValues: true }
        ),
      })
    );

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ ok: true, lastPing: now }),
    };
  } catch (error) {
    console.error("Error writing pulse:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Failed to write pulse data" }),
    };
  }
};
