import { S3Event, Context } from "aws-lambda";
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";

const cloudFrontClient = new CloudFrontClient({ region: "us-east-1" });

export const handler = async (event: S3Event, _context: Context) => {
  const distributionId = process.env.DISTRIBUTION_ID;

  if (!distributionId) {
    throw new Error("DISTRIBUTION_ID environment variable is not set");
  }

  console.log(`S3 event triggered for ${event.Records.length} object(s)`);
  console.log(`Creating invalidation for all paths (/*)`);

  const invalidationParams = {
    DistributionId: distributionId,
    InvalidationBatch: {
      CallerReference: `s3-trigger-${Date.now()}`,
      Paths: {
        Quantity: 1,
        Items: ["/*"],
      },
    },
  };

  try {
    const command = new CreateInvalidationCommand(invalidationParams);
    const response = await cloudFrontClient.send(command);

    console.log(
      `Invalidation created successfully. ID: ${response.Invalidation?.Id}`
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Cache invalidation created for all paths",
        invalidationId: response.Invalidation?.Id,
        paths: ["/*"],
      }),
    };
  } catch (error) {
    console.error("Error creating invalidation:", error);
    throw error;
  }
};
