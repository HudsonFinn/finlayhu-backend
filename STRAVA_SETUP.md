# Strava API Integration Setup Guide

This guide walks through setting up the Strava API integration for fhudson.com.

## Architecture Overview

The Strava integration follows the same pattern as the Oura integration:

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  EventBridge    │────▶│  Lambda         │────▶│  S3 Bucket      │
│  (hourly cron)  │     │  sync-strava    │     │  strava-data-*  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                │                        │
                                ▼                        │
                        ┌─────────────────┐              │
                        │ Secrets Manager │              │
                        │ - access_token  │              │
                        │ - refresh_token │              │
                        │ - expires_at    │              │
                        │ - client_id     │              │
                        │ - client_secret │              │
                        └─────────────────┘              │
                                                         │
┌─────────────────┐     ┌─────────────────┐              │
│  API Gateway    │────▶│  Lambda         │◀─────────────┘
│  /api/strava    │     │  get-strava     │
└─────────────────┘     └─────────────────┘
```

## Prerequisites

Before deploying, you need to:

1. Create a Strava API application
2. Perform OAuth authorization
3. Store credentials in AWS Secrets Manager
4. Install dependencies
5. Deploy the CDK stack

## Step 1: Create Strava API Application

1. Go to https://www.strava.com/settings/api
2. Create a new application with these settings:
   - **Application Name**: fhudson.com
   - **Category**: Data Visualization or Fitness
   - **Website**: https://fhudson.com
   - **Authorization Callback Domain**: localhost (for initial setup)
3. Note your **Client ID** and **Client Secret**

## Step 2: Perform OAuth Authorization

### 2.1 Authorize Your Account

Open this URL in your browser (replace `{CLIENT_ID}` with your actual Client ID):

```
https://www.strava.com/oauth/authorize?client_id={CLIENT_ID}&redirect_uri=http://localhost&response_type=code&scope=activity:read_all,profile:read_all&approval_prompt=force
```

### 2.2 Extract Authorization Code

After authorizing, you'll be redirected to `http://localhost/?code=XXXXXX`. Copy the `code` parameter value.

### 2.3 Exchange Code for Tokens

Run this curl command (replace placeholders):

```bash
curl -X POST https://www.strava.com/oauth/token \
  -d client_id={CLIENT_ID} \
  -d client_secret={CLIENT_SECRET} \
  -d code={CODE_FROM_STEP_2.2} \
  -d grant_type=authorization_code
```

The response will look like:

```json
{
  "token_type": "Bearer",
  "expires_at": 1234567890,
  "expires_in": 21600,
  "refresh_token": "abc123...",
  "access_token": "xyz789..."
}
```

Save all these values - you'll need them in the next step.

## Step 3: Store Credentials in AWS Secrets Manager

### 3.1 Create the Secret

Using AWS CLI:

```bash
aws secretsmanager create-secret \
  --name STRAVA_SECRETS \
  --description "Strava API OAuth credentials" \
  --secret-string '{
    "STRAVA_CLIENT_ID": "YOUR_CLIENT_ID",
    "STRAVA_CLIENT_SECRET": "YOUR_CLIENT_SECRET",
    "STRAVA_ACCESS_TOKEN": "ACCESS_TOKEN_FROM_STEP_2.3",
    "STRAVA_REFRESH_TOKEN": "REFRESH_TOKEN_FROM_STEP_2.3",
    "STRAVA_EXPIRES_AT": EXPIRES_AT_FROM_STEP_2.3
  }'
```

Or using the AWS Console:
1. Go to AWS Secrets Manager
2. Click "Store a new secret"
3. Select "Other type of secret"
4. Add the key-value pairs as shown above
5. Name it `STRAVA_SECRETS`

### 3.2 Update the Secret ARN

After creating the secret, note its ARN. Update `lib/strava-stack.ts` line 52:

```typescript
STRAVA_SECRETS_ARN: "arn:aws:secretsmanager:us-east-1:457471291771:secret:STRAVA_SECRETS-XXXXXX"
```

Replace `XXXXXX` with the actual suffix from your secret's ARN.

## Step 4: Install Dependencies

```bash
cd /Users/finlayhudson/Workplace/finlayhu-backend
npm install
```

This will install the new `@aws-sdk/client-secrets-manager` dependency.

## Step 5: Deploy the CDK Stack

### 5.1 Build the Project

```bash
npm run build
```

### 5.2 Deploy Strava Stack

```bash
cdk deploy StravaStack
```

This creates:
- S3 bucket for storing activity data
- Lambda function for syncing data from Strava
- EventBridge rule for hourly execution
- IAM roles and permissions

### 5.3 Deploy Updated InfraStack

```bash
cdk deploy InfraStack
```

This updates:
- API Gateway routes for `/api/strava` and `/api/strava/{date}`
- CloudFront distribution with new behavior
- Lambda function for serving data

## Step 6: Verify Deployment

### 6.1 Test the Sync Lambda

Manually trigger the sync Lambda to verify it works:

```bash
aws lambda invoke \
  --function-name StravaStack-sync-strava \
  --payload '{}' \
  response.json

cat response.json
```

Expected output: `{"statusCode": 200, "body": "..."}`

### 6.2 Check S3 Bucket

List files in the S3 bucket:

```bash
aws s3 ls s3://stravastack-stravadata-XXXXXX/
```

You should see files like: `strava-data-2026-02-04-15.json`

### 6.3 Test the API

After the hourly sync runs, test the API:

```bash
# Get today's data
curl https://fhudson.com/api/strava

# Get specific date
curl https://fhudson.com/api/strava/2026-02-04
```

## API Response Format

### GET /api/strava or /api/strava/{date}

```json
{
  "date": "2026-02-04",
  "fetched_at": "2026-02-04T15:00:00.000Z",
  "activities": [
    {
      "id": 12345,
      "name": "Morning Run",
      "type": "Run",
      "sport_type": "Run",
      "distance": 5000,
      "moving_time": 1800,
      "elapsed_time": 1850,
      "total_elevation_gain": 45,
      "start_date": "2026-02-04T07:30:00Z",
      "start_date_local": "2026-02-04T07:30:00Z",
      "timezone": "(GMT+00:00) Europe/London",
      "average_speed": 2.78,
      "max_speed": 3.5,
      "average_heartrate": 145,
      "max_heartrate": 165,
      "calories": 350,
      "segment_efforts": [
        {
          "id": 67890,
          "name": "Hill Segment",
          "elapsed_time": 300,
          "moving_time": 295,
          "distance": 800,
          "pr_rank": 2
        }
      ]
    }
  ],
  "summary": {
    "total_distance": 5000,
    "total_moving_time": 1800,
    "total_elevation": 45,
    "activity_count": 1,
    "types": {
      "Run": 1
    }
  }
}
```

## Token Refresh

The sync Lambda automatically handles token refresh:

1. Before each sync, it checks if the access token expires in less than 1 hour
2. If expiring soon, it uses the refresh token to get a new access token
3. New tokens are automatically saved back to Secrets Manager

You don't need to manually refresh tokens!

## Rate Limits

Strava API rate limits:
- **15 minutes**: 100 reads, 200 total
- **Daily**: 1,000 reads, 2,000 total

Hourly sync is conservative:
- ~3 API calls per hour (1 list + 2 activity details)
- ~72 calls per day
- Well under the 1,000 daily limit

## Troubleshooting

### Lambda Function Fails

Check CloudWatch logs:

```bash
aws logs tail /aws/lambda/StravaStack-sync-strava --follow
```

### Token Refresh Fails

1. Verify the secret exists and has correct values
2. Check the client ID and secret are correct
3. Ensure the refresh token hasn't been revoked

### No Data in S3

1. Check if the Lambda function is being triggered (CloudWatch Events)
2. Check Lambda execution logs for errors
3. Verify the Lambda has write permissions to S3

### API Returns 404

1. Wait for the hourly sync to run at the top of the next hour
2. Check if data exists in S3 for the requested date
3. Verify CloudFront is routing requests correctly

## Files Created

- `lib/strava-stack.ts` - CDK infrastructure definition
- `lib/sync-strava.function.ts` - Hourly data collector Lambda
- `lib/get-strava.function.ts` - API handler Lambda
- `lib/strava-types.ts` - TypeScript interfaces
- Updated `lib/infra-stack.ts` - API Gateway and CloudFront
- Updated `bin/infra.ts` - Stack initialization

## Next Steps

Once deployed and working:

1. **Frontend Integration**: Build a dashboard to display your activities
2. **Webhooks**: Add webhook support for real-time activity updates
3. **Historical Backfill**: Create a one-time script to load historical activities
4. **Analytics**: Correlate with Oura data for training insights

---

*Last updated: 2026-02-04*
