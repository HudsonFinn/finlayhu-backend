import { APIGatewayEvent, APIGatewayProxyResult, Context } from "aws-lambda";

const OURA_API_KEY_SECRET_ARN =
  "arn:aws:secretsmanager:us-east-1:457471291771:secret:OURA_API_KEY-tXksnW";

const fetchData = async () => {
  const secretResponse = await fetch(
    `http://localhost:2773/secretsmanager/get?secretId=${encodeURIComponent(
      OURA_API_KEY_SECRET_ARN
    )}&withDecryption=true`,
    {
      headers: {
        "X-Aws-Parameters-Secrets-Token": process.env.AWS_SESSION_TOKEN!!,
      },
    }
  );

  const secretsJSON = await secretResponse.json();

  const OURA_API_KEY = JSON.parse(secretsJSON.SecretString)["OURA_API_KEY"];

  const OURA_ENDPOINT =
    "https://api.ouraring.com/v2/usercollection/personal_info";
  const response = await fetch(OURA_ENDPOINT, {
    headers: { Authorization: `Bearer ${OURA_API_KEY}` },
  });

  const json = (await response.json()) as Response;

  return json;
};

export const handler = async (
  _event: APIGatewayEvent,
  _context: Context
): Promise<APIGatewayProxyResult> => {
  let todaysData;
  try {
    todaysData = await fetchData();
  } catch (e) {
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
      },
      body: JSON.stringify({
        message: `Failed to fetch data from oura: ${e}`,
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
    body: JSON.stringify(todaysData),
  };
};
