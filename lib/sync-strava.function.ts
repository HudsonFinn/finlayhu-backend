import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  SecretsManagerClient,
  UpdateSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  StravaActivity,
  StravaTokenResponse,
  StravaSecrets,
  StravaDayData,
} from "./strava-types";
import { putStravaActivity, putStravaSummary } from "./dynamodb-helper";

const s3Client = new S3Client({ region: "us-east-1" });
const secretsClient = new SecretsManagerClient({ region: "us-east-1" });
const BUCKET_NAME = process.env.BUCKET_NAME!;
const STRAVA_SECRETS_ARN = process.env.STRAVA_SECRETS_ARN!;

interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

async function getSecrets(): Promise<StravaSecrets> {
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  const response = await fetch(
    `http://localhost:2773/secretsmanager/get?secretId=${STRAVA_SECRETS_ARN}`,
    {
      headers: {
        "X-Aws-Parameters-Secrets-Token": sessionToken || "",
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch secrets: ${response.statusText}`);
  }

  const data = await response.json();
  return JSON.parse(data.SecretString);
}

async function updateSecrets(secrets: StravaSecrets): Promise<void> {
  await secretsClient.send(
    new UpdateSecretCommand({
      SecretId: STRAVA_SECRETS_ARN,
      SecretString: JSON.stringify(secrets),
    })
  );
}

async function refreshAccessToken(
  secrets: StravaSecrets
): Promise<StravaSecrets> {
  const response = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: secrets.STRAVA_CLIENT_ID,
      client_secret: secrets.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: secrets.STRAVA_REFRESH_TOKEN,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.statusText}`);
  }

  const tokenData: StravaTokenResponse = await response.json();

  return {
    ...secrets,
    STRAVA_ACCESS_TOKEN: tokenData.access_token,
    STRAVA_REFRESH_TOKEN: tokenData.refresh_token,
    STRAVA_EXPIRES_AT: tokenData.expires_at,
  };
}

async function fetchActivities(
  accessToken: string,
  afterTimestamp: number
): Promise<StravaActivity[]> {
  const response = await fetch(
    `https://www.strava.com/api/v3/athlete/activities?after=${afterTimestamp}&per_page=30`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch activities: ${response.statusText}`);
  }

  return response.json();
}

async function fetchActivityDetails(
  accessToken: string,
  activityId: number
): Promise<StravaActivity> {
  const response = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}?include_all_efforts=true`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch activity ${activityId}: ${response.statusText}`
    );
  }

  return response.json();
}

function calculateSummary(activities: StravaActivity[]) {
  const summary = {
    total_distance: 0,
    total_moving_time: 0,
    total_elevation: 0,
    activity_count: activities.length,
    types: {} as Record<string, number>,
  };

  for (const activity of activities) {
    summary.total_distance += activity.distance || 0;
    summary.total_moving_time += activity.moving_time || 0;
    summary.total_elevation += activity.total_elevation_gain || 0;

    const type = activity.type || "Unknown";
    summary.types[type] = (summary.types[type] || 0) + 1;
  }

  return summary;
}

export async function handler(): Promise<LambdaResponse> {
  try {
    console.log("Starting Strava data sync");

    // Get secrets
    let secrets = await getSecrets();
    console.log("Secrets retrieved");

    // Check if token needs refresh (expires in less than 1 hour)
    const now = Math.floor(Date.now() / 1000);
    if (secrets.STRAVA_EXPIRES_AT < now + 3600) {
      console.log("Access token expired or expiring soon, refreshing...");
      secrets = await refreshAccessToken(secrets);
      await updateSecrets(secrets);
      console.log("Token refreshed and updated");
    }

    // Fetch activities from the last 24 hours
    const yesterday = now - 86400;
    const activities = await fetchActivities(
      secrets.STRAVA_ACCESS_TOKEN,
      yesterday
    );
    console.log(`Found ${activities.length} activities`);

    // Fetch detailed data for each activity (including segments)
    const detailedActivities = await Promise.all(
      activities.map((activity) =>
        fetchActivityDetails(secrets.STRAVA_ACCESS_TOKEN, activity.id)
      )
    );
    console.log("Fetched detailed activity data");

    // Prepare data structure
    const date = new Date().toISOString().split("T")[0];
    const hour = new Date().getUTCHours().toString().padStart(2, "0");
    const dayData: StravaDayData = {
      date,
      fetched_at: new Date().toISOString(),
      activities: detailedActivities,
      summary: calculateSummary(detailedActivities),
    };

    // Save to S3
    const key = `strava-data-${date}-${hour}.json`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: JSON.stringify(dayData, null, 2),
        ContentType: "application/json",
      })
    );
    console.log(`Saved data to S3: ${key}`);

    // Save to DynamoDB (dual-write)
    const tableName = process.env.TABLE_NAME;
    if (tableName) {
      try {
        // Write each activity
        for (const activity of detailedActivities) {
          await putStravaActivity(date, activity as unknown as Record<string, unknown>);
        }
        // Write the summary
        await putStravaSummary(date, dayData.summary);
        console.log(`Saved to DynamoDB: ${date} (${detailedActivities.length} activities)`);
      } catch (error) {
        console.error("DynamoDB write failed:", error);
        // Don't fail - S3 write succeeded
      }
    }

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
      },
      body: JSON.stringify({
        message: "Strava data synced successfully",
        key,
        activityCount: detailedActivities.length,
      }),
    };
  } catch (error) {
    console.error("Error syncing Strava data:", error);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
      },
      body: JSON.stringify({
        error: "Failed to sync Strava data",
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}
