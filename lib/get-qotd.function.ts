import { Context, APIGatewayProxyResult, APIGatewayEvent } from "aws-lambda";

type Quote = {
  q?: string;
  a?: string;
  i?: string;
  c?: number;
};

type Response = Array<Quote> | undefined;

const getQuote = async (): Promise<Quote> => {
  const quoteOfTheDayUrl = "https://zenquotes.io/api/today";
  // Fail cleanly before the Lambda's own timeout, so the caller gets a 500 rather than a 502
  const response = await fetch(quoteOfTheDayUrl, {
    signal: AbortSignal.timeout(5000),
  });
  const json = (await response.json()) as Response;

  if (!json || !Array.isArray(json) || json.length < 1)
    throw new Error("No data or empty array returned");
  const data = json[0];
  if (!data.q || !data.a) throw new Error("Quote is missing quote or author");

  return data;
};

export const handler = async (
  _event: APIGatewayEvent,
  _context: Context
): Promise<APIGatewayProxyResult> => {
  let todaysData;
  try {
    todaysData = await getQuote();
  } catch (e) {
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({
        message: `Failed to fetch data from https://zenquotes.io/api/today: ${e}`,
      }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
      // CloudFront keeps the quote for an hour, so zenquotes sees a few dozen requests a day
      "Cache-Control": "public, max-age=3600",
    },
    body: JSON.stringify(todaysData),
  };
};
