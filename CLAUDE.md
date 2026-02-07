# finlayhu-backend

AWS CDK infrastructure for fhudson.com, including API endpoints for Oura Ring data, Strava activities, and Quote of the Day.

## Architecture Overview

This project uses AWS CDK to deploy:

- **CloudFront Distribution**: Serves static site and API endpoints
- **DynamoDB Table**: Primary storage for health and fitness data
- **S3 Buckets**: Legacy storage (fallback) and static site assets
- **Lambda Functions**: API handlers and data sync functions
- **API Gateway**: REST API endpoints
- **EventBridge Rules**: Scheduled data collection (hourly cron jobs)
- **Secrets Manager**: Secure storage for API credentials

## Stack Structure

### 1. DatabaseStack
DynamoDB table for health and fitness data.

**Components:**
- DynamoDB table: `HealthDataTable`
- Partition Key: `PK` (e.g., `OURA#2026-02-07` or `STRAVA#2026-02-07`)
- Sort Key: `SK` (e.g., `SLEEP`, `ACTIVITY#12345`, `SUMMARY`)
- GSI1: Query by data type and date range
- GSI2: Query Strava activities by type
- Point-in-time recovery enabled
- TTL enabled (auto-delete data >2 years old)

### 2. OuraStack
Collects sleep, readiness, and activity data from Oura Ring API.

**Components:**
- S3 bucket: Stores hourly snapshots (legacy fallback)
- Lambda: `sync-oura-data` (triggered hourly)
- EventBridge: Cron rule (every hour at :00)
- Secrets Manager: `OURA_API_KEY`

**API Endpoints:**
- `GET /api/oura` - Today's data
- `GET /api/oura/{date}` - Specific date (YYYY-MM-DD)

### 3. StravaStack
Collects running and cycling activity data from Strava API.

**Components:**
- S3 bucket: Stores hourly snapshots (legacy fallback)
- Lambda: `sync-strava` (triggered hourly)
- EventBridge: Cron rule (every hour at :00)
- Secrets Manager: `STRAVA_SECRETS` (OAuth tokens with auto-refresh)

**API Endpoints:**
- `GET /api/strava` - Today's activities
- `GET /api/strava/{date}` - Specific date (YYYY-MM-DD)

**Features:**
- Automatic OAuth token refresh (tokens expire every 6 hours)
- Includes segment efforts and PRs
- Activity summaries with distance, time, elevation, heart rate
- Rate limit safe: ~72 API calls/day (well under 1,000 limit)

### 4. InfraStack
Main infrastructure including CloudFront, API Gateway, and get Lambda functions.

**Components:**
- CloudFront distribution with custom domain
- S3 bucket for static site assets
- API Gateway routes for all endpoints
- Lambda functions: `get-qotd`, `get-oura-data`, `get-strava-data`, `invalidate-cloudfront`
- Cache policies (QOTD: 24h, Oura: 1h, Strava: 30min)

### 5. ChalkboardStack
Deployment for the Chalkboard UI component library.

## Git Workflow

- Use **conventional commits** format: `type: description`
  - `feat:` new feature
  - `fix:` bug fix
  - `docs:` documentation changes
  - `refactor:` code refactoring
  - `chore:` maintenance tasks
- Commit regularly to create logical checkpoints
- Keep commits focused on a single change or feature

## Common Commands

### Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Watch mode
npm run watch

# Run tests
npm test
```

### CDK Deployment

```bash
# List all stacks
cdk list

# Synthesize CloudFormation template
cdk synth StravaStack

# Deploy a specific stack
cdk deploy DatabaseStack
cdk deploy OuraStack
cdk deploy StravaStack
cdk deploy InfraStack

# Deploy multiple stacks
cdk deploy OuraStack StravaStack

# Deploy all stacks
cdk deploy --all

# Show differences before deployment
cdk diff StravaStack

# Destroy a stack
cdk destroy StravaStack
```

### DynamoDB

```bash
# Query Oura data for a specific date
aws dynamodb query \
  --table-name HealthDataTable \
  --key-condition-expression "PK = :pk" \
  --expression-attribute-values '{":pk":{"S":"OURA#2026-02-07"}}' \
  --region us-east-1

# Query Strava data for a specific date
aws dynamodb query \
  --table-name HealthDataTable \
  --key-condition-expression "PK = :pk" \
  --expression-attribute-values '{":pk":{"S":"STRAVA#2026-02-07"}}' \
  --region us-east-1

# Scan table (use sparingly - reads all items)
aws dynamodb scan \
  --table-name HealthDataTable \
  --max-items 10 \
  --region us-east-1

# Get table info
aws dynamodb describe-table \
  --table-name HealthDataTable \
  --region us-east-1
```

### Strava Integration

```bash
# Test the sync Lambda manually
aws lambda invoke \
  --function-name StravaStack-sync-strava-XXXXX \
  --region us-east-1 \
  response.json && cat response.json

# Check S3 bucket for stored data (legacy)
aws s3 ls s3://stravastack-stravadata-XXXXX/ --region us-east-1

# View sync Lambda logs
aws logs tail /aws/lambda/StravaStack-sync-strava-XXXXX --follow --region us-east-1

# Test API endpoint (today's data)
curl https://fhudson.com/api/strava

# Test API endpoint (specific date)
curl https://fhudson.com/api/strava/2026-02-07

# Get detailed activity data with jq
curl https://fhudson.com/api/strava | jq '.activities[0]'

# View token expiry time
aws secretsmanager get-secret-value \
  --secret-id STRAVA_SECRETS \
  --region us-east-1 \
  --query SecretString \
  --output text | jq '.STRAVA_EXPIRES_AT'
```

### Oura Integration

```bash
# Test the sync Lambda manually
aws lambda invoke \
  --function-name OuraStack-sync-oura-data-XXXXX \
  --region us-east-1 \
  response.json && cat response.json

# Check S3 bucket for stored data (legacy)
aws s3 ls s3://ourastack-ouradata-XXXXX/ --region us-east-1

# Test API endpoint
curl https://fhudson.com/api/oura
curl https://fhudson.com/api/oura/2026-02-07
```

### CloudFront

```bash
# Get distribution ID
aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='Personal Site Distribution'].Id" \
  --output text \
  --region us-east-1

# Create cache invalidation
aws cloudfront create-invalidation \
  --distribution-id XXXXX \
  --paths "/*" \
  --region us-east-1

# View invalidation status
aws cloudfront get-invalidation \
  --distribution-id XXXXX \
  --id INVALIDATION_ID \
  --region us-east-1
```

### Secrets Manager

```bash
# View Strava secrets (without values)
aws secretsmanager describe-secret \
  --secret-id STRAVA_SECRETS \
  --region us-east-1

# Get secret value (includes tokens)
aws secretsmanager get-secret-value \
  --secret-id STRAVA_SECRETS \
  --region us-east-1 \
  --query SecretString \
  --output text | jq

# Update Strava secrets (if needed)
aws secretsmanager update-secret \
  --secret-id STRAVA_SECRETS \
  --secret-string '{"STRAVA_CLIENT_ID":"...","STRAVA_CLIENT_SECRET":"...","STRAVA_ACCESS_TOKEN":"...","STRAVA_REFRESH_TOKEN":"...","STRAVA_EXPIRES_AT":1234567890}' \
  --region us-east-1
```

## Data Storage Format

### DynamoDB (Primary Storage)

**Oura Data:**
- PK: `OURA#YYYY-MM-DD`
- SK: `SLEEP`, `READINESS`, `ACTIVITY`, or `WORKOUT`
- Each hourly sync overwrites existing data (always latest version)

**Strava Data:**
- PK: `STRAVA#YYYY-MM-DD`
- SK: `ACTIVITY#<activity_id>` or `SUMMARY`
- Activities use Strava ID for uniqueness
- Summary is overwritten hourly

### S3 (Legacy Fallback)

**Strava:** `strava-data-YYYY-MM-DD-HH.json`

```json
{
  "date": "2026-02-07",
  "fetched_at": "2026-02-07T15:00:00.000Z",
  "activities": [
    {
      "id": 12345,
      "name": "Morning Run",
      "type": "Run",
      "distance": 5000,
      "moving_time": 1800,
      "average_heartrate": 145,
      "segment_efforts": [...]
    }
  ],
  "summary": {
    "total_distance": 5000,
    "total_moving_time": 1800,
    "total_elevation": 45,
    "activity_count": 1,
    "types": { "Run": 1 }
  }
}
```

**Oura:** `oura-data-YYYY-MM-DD-HH.json`

```json
{
  "readiness": { "data": [...], "next_token": null },
  "sleep": { "data": [...], "next_token": null },
  "activity": { "data": [...], "next_token": null },
  "workout": { "data": [...], "next_token": null }
}
```

## Troubleshooting

### Strava Token Issues

If activities aren't syncing, check token expiry:

```bash
# Check token expiry timestamp
aws secretsmanager get-secret-value \
  --secret-id STRAVA_SECRETS \
  --region us-east-1 \
  --query SecretString --output text | jq '.STRAVA_EXPIRES_AT'

# Compare with current time (Unix timestamp)
date +%s
```

If token is expired and not auto-refreshing, check Lambda logs for errors.

### Lambda Function Errors

```bash
# View recent logs
aws logs tail /aws/lambda/StravaStack-sync-strava-XXXXX --region us-east-1

# View logs from specific time
aws logs tail /aws/lambda/StravaStack-sync-strava-XXXXX \
  --since 1h \
  --region us-east-1
```

### API Returns 404

1. Check if data exists in DynamoDB for the requested date
2. Check if data exists in S3 (fallback) for the requested date
3. Verify Lambda has read permissions to DynamoDB table and S3 bucket
4. Check CloudFront cache (might be caching old 404 response)
5. Create cache invalidation if needed

### CDK Deployment Fails

```bash
# Check for drift
cdk diff StravaStack

# View CloudFormation events
aws cloudformation describe-stack-events \
  --stack-name StravaStack \
  --region us-east-1 \
  --max-items 10
```

## Recent Changes

### 2026-02-07: DynamoDB Migration

Migrated from S3-only storage to DynamoDB with S3 fallback:

**Files Created:**
- `lib/database-stack.ts` - DynamoDB table with GSIs
- `lib/database-types.ts` - TypeScript interfaces and key builders
- `lib/dynamodb-helper.ts` - CRUD operations (put/query/transform)

**Files Modified:**
- `bin/infra.ts` - Added DatabaseStack, passed table to other stacks
- `lib/oura-stack.ts` - Grants DynamoDB write permissions
- `lib/strava-stack.ts` - Grants DynamoDB write permissions
- `lib/infra-stack.ts` - Grants DynamoDB read permissions to get functions
- `lib/sync-oura-data.function.ts` - Dual-write to S3 + DynamoDB
- `lib/sync-strava.function.ts` - Dual-write to S3 + DynamoDB
- `lib/get-oura-data.function.ts` - Read from DynamoDB with S3 fallback
- `lib/get-strava.function.ts` - Read from DynamoDB with S3 fallback
- `package.json` - Added @aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb

**Renamed Files:**
- `save-oura-data.function.ts` → `sync-oura-data.function.ts`
- `fetch-oura-data.function.ts` → `get-oura-data.function.ts`

**Features:**
- Overwrite pattern: each sync replaces existing data (no duplication)
- Oura: 4 records per day vs 96 files per day in S3
- Sub-50ms query latency vs 150-200ms with S3
- S3 fallback for historical data not yet in DynamoDB

### 2026-02-04: Strava Integration Added

Added comprehensive Strava API integration following the Oura pattern.

## Environment

- **AWS Region**: us-east-1
- **Domain**: fhudson.com
- **CDK Version**: 2.161.1
- **Node Version**: 22.x (recommended)
- **TypeScript Version**: 5.6.2

## Security Notes

- All API keys and tokens stored in AWS Secrets Manager
- Lambda functions use IAM roles with minimal required permissions
- DynamoDB access controlled via IAM roles
- CloudFront serves API through HTTPS only
- CORS headers configured for cross-origin requests
- No sensitive data exposed in CloudWatch logs

## Links

- [Strava API Documentation](https://developers.strava.com/docs/reference/)
- [Oura API Documentation](https://cloud.ouraring.com/v2/docs)
- [AWS CDK Documentation](https://docs.aws.amazon.com/cdk/v2/guide/home.html)
- [DynamoDB Documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/)
- Setup Guide: See `STRAVA_SETUP.md`
- Migration Plan: See `DATABASE_MIGRATION_PLAN.md`
