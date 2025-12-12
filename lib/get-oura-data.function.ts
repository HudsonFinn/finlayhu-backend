import { APIGatewayEvent, APIGatewayProxyResult, Context } from "aws-lambda";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const OURA_API_KEY_SECRET_ARN =
  "arn:aws:secretsmanager:us-east-1:457471291771:secret:OURA_API_KEY-tXksnW";

const s3Client = new S3Client({ region: "us-east-1" });

const authorize = async () => {
  const SECRETS_URL = `http://localhost:2773/secretsmanager/get?secretId=${encodeURIComponent(
    OURA_API_KEY_SECRET_ARN
  )}&withDecryption=true`;

  const sessionToken = process.env.AWS_SESSION_TOKEN;

  if (!sessionToken) throw Error("[authorize] No AWS session token found");

  let secretsResponse: any = await fetch(SECRETS_URL, {
    headers: {
      "X-Aws-Parameters-Secrets-Token": sessionToken,
    },
  });

  secretsResponse = await secretsResponse.json();

  const OURA_API_KEY: string = JSON.parse(secretsResponse.SecretString)[
    "OURA_API_KEY"
  ];

  return OURA_API_KEY;
};

const fetchEndpointData = async (endpoint: string, authToken: string) => {
  let response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${authToken}` },
  });

  response = await response.json();

  return response;
};

const fetchData = async () => {
  const OURA_API_KEY = await authorize();

  const OURA_SLEEP_ENDPOINT =
    "https://api.ouraring.com/v2/usercollection/daily_sleep";
  let sleepDataRequest = fetchEndpointData(OURA_SLEEP_ENDPOINT, OURA_API_KEY);

  const OURA_ACTIVITY_ENDPOINT =
    "https://api.ouraring.com/v2/usercollection/daily_activity";
  let activityDataRequest = fetchEndpointData(
    OURA_ACTIVITY_ENDPOINT,
    OURA_API_KEY
  );

  const OURA_READINESS_ENDPOINT =
    "https://api.ouraring.com/v2/usercollection/daily_readiness";
  let readinessDataRequest = fetchEndpointData(
    OURA_READINESS_ENDPOINT,
    OURA_API_KEY
  );

  const data = await Promise.all([
    sleepDataRequest,
    activityDataRequest,
    readinessDataRequest,
  ]);
  const [sleepData, activityData, readinessData] = data;

  return {
    readiness: readinessData,
    sleep: sleepData,
    activity: activityData,
  };
};

const saveToS3 = async (data: any) => {
  const bucketName = process.env.BUCKET_NAME;
  if (!bucketName) {
    throw new Error("BUCKET_NAME environment variable is not set");
  }

  // Create filename with current date (YYYY-MM-DD format)
  const currentDate = new Date().toISOString().split("T")[0];
  const fileName = `oura-data-${currentDate}.json`;

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: fileName,
    Body: JSON.stringify(data, null, 2),
    ContentType: "application/json",
  });

  await s3Client.send(command);

  return fileName;
};

export const handler = async (
  _event: APIGatewayEvent,
  _context: Context
): Promise<APIGatewayProxyResult> => {
  let todaysData;
  let savedFileName;

  try {
    todaysData = await fetchData();
    savedFileName = await saveToS3(todaysData);
  } catch (e) {
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
      },
      body: JSON.stringify({
        message: `Failed to fetch data from oura or save to S3: ${e}`,
      }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
    },
    body: JSON.stringify({
      message: `Data saved successfully to ${savedFileName}`,
      data: todaysData,
    }),
  };
};
