import { Context, APIGatewayProxyResult, APIGatewayEvent } from 'aws-lambda';

type Quote = {
	q?: string;
	a?: string;
	i?: string;
	c?: number;
};

type Response = Array<Quote> | undefined;

const getQuote = async (): Promise<Quote> => {
    const quoteOfTheDayUrl = "https://zenquotes.io/api/today";
    const response = await fetch(quoteOfTheDayUrl);
    const json = (await response.json()) as Response;

    if (!json || !Array.isArray(json) || json.length < 1) throw new Error("No data or empty array returned");
    const data = json[0];
    if (!data.q || !data.a) throw new Error("Quote is missing quote or author");
    
    return data;
}

export const handler = async (_event: APIGatewayEvent, _context: Context): Promise<APIGatewayProxyResult> => {
    let todaysData;
    try {
        todaysData = await getQuote();
    } catch (e) {
        return {
            statusCode: 500,
            headers: {
                "Access-Control-Allow-Headers" : "Content-Type",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "OPTIONS,POST,GET"
            },
            body: JSON.stringify({
                message: `Failed to fetch data from https://zenquotes.io/api/today: ${e}`
            }
                
            ),
        }; 
    }

    return {
        statusCode: 200,
        headers: {
            "Access-Control-Allow-Headers" : "Content-Type",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "OPTIONS,POST,GET"
        },
        body: JSON.stringify(todaysData),
    };
};