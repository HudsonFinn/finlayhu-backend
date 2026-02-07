# Plan: Migrate S3 Storage to DynamoDB

## Overview

Migrate Oura and Strava data from S3 hourly snapshots to DynamoDB for efficient querying, date range support, and activity filtering. This eliminates data duplication (24 hourly files → 1 record per day, overwritten with latest data) and enables sub-50ms queries vs current 150-200ms.

**Timeline**: 3-5 days (fast migration with safety checks)
**Backfill**: Last 90 days of historical data
**API Changes**: Maintain current endpoints, add advanced features post-migration

## Why DynamoDB?

- **Serverless fit**: No VPC/connection management, automatic scaling
- **Cost effective**: ~$1-2/month vs RDS minimum $15-20/month
- **Performance**: Single-digit ms latency vs S3's 150-200ms
- **Lambda integration**: Native SDK, minimal cold start impact
- **Operational simplicity**: Zero maintenance, auto-backup with PITR

## Current Limitations (S3 Approach)

1. **No date range queries**: Must fetch each day individually
2. **Client-side sorting**: List all files, sort in Lambda memory (O(n))
3. **No filtering**: Cannot query by activity type, scores, or metrics
4. **Data duplication**: Daily data stored 24x (one per hourly snapshot) - wastes storage
5. **Slow queries**: 150-200ms per date (list + get + parse)

**DynamoDB Solution**: Overwrite pattern keeps only the latest version of each day's data. Each hourly sync replaces the previous record (same PK+SK), eliminating duplication.

## Data Model

### DynamoDB Table: `HealthDataTable`

**Partition Key**: `PK` = `OURA#2026-02-04` or `STRAVA#2026-02-04`
**Sort Key**: `SK` = `SLEEP`, `READINESS`, `ACTIVITY`, `WORKOUT`, `ACTIVITY#123456`, or `SUMMARY`

**Key Design Principles**:
- **Oura data**: One record per day per data type, overwritten hourly with latest data
- **Strava data**: One record per activity (using activity ID), plus one summary record per day

**Global Secondary Indexes**:
- **GSI1**: Query by data source and date range (`OURA#SLEEP` → `2026-02-04`)
- **GSI2**: Filter by activity type (`STRAVA#TYPE#Run` → `2026-02-04`)

### Oura Item Structure (Overwrite Pattern)

Each hourly sync overwrites the same record, keeping only the most recent data:

```json
{
  "PK": "OURA#2026-02-04",
  "SK": "SLEEP",
  "GSI1PK": "OURA#SLEEP",
  "GSI1SK": "2026-02-04",
  "dataSource": "OURA",
  "date": "2026-02-04",
  "updated_at": "2026-02-04T15:00:00Z",
  "data": { "id": "abc123", "score": 85, "contributors": {...} }
}
```

This results in **4 records per day** (SLEEP, READINESS, ACTIVITY, WORKOUT) instead of 96 (4 types × 24 hours).

### Strava Item Structure

Activities use the Strava activity ID in the SK to ensure uniqueness:

```json
{
  "PK": "STRAVA#2026-02-04",
  "SK": "ACTIVITY#12345678",
  "GSI1PK": "STRAVA#ACTIVITY",
  "GSI1SK": "2026-02-04",
  "GSI2PK": "STRAVA#TYPE#Run",
  "GSI2SK": "2026-02-04",
  "dataSource": "STRAVA",
  "date": "2026-02-04",
  "activityType": "Run",
  "data": { "id": 12345678, "name": "Morning Run", "distance": 5000, ... }
}
```

Daily summary (overwritten hourly):

```json
{
  "PK": "STRAVA#2026-02-04",
  "SK": "SUMMARY",
  "dataSource": "STRAVA",
  "date": "2026-02-04",
  "updated_at": "2026-02-04T15:00:00Z",
  "data": { "total_distance": 5000, "activity_count": 1, "types": {"Run": 1} }
}
```

## Migration Strategy: Dual-Write Pattern

**Day 1**: Deploy database, backfill 90 days
**Days 2-3**: Sync Lambdas write to both S3 and DynamoDB
**Day 4**: Fetch Lambdas read from DynamoDB (S3 fallback)
**Day 5**: Remove S3 write logic (DynamoDB only)

**Rollback**: Keep S3 data intact, environment variable switches between DB and S3

## Implementation Steps

### 1. Create Database Infrastructure

**New File**: `lib/database-stack.ts`

Create DynamoDB table with:
- BillingMode: PAY_PER_REQUEST (on-demand)
- PointInTimeRecovery: enabled
- TimeToLive: enabled (auto-delete data >2 years old)
- Stream: NEW_AND_OLD_IMAGES (for future analytics)
- GSI1, GSI2 for querying
- Export table name/ARN for other stacks

**New File**: `lib/database-types.ts`

TypeScript interfaces:
- `DynamoDBBaseItem` (PK, SK, GSI keys, metadata)
- `OuraDynamoDBItem`, `StravaDynamoDBItem`
- `QueryParams` for fetch functions
- Helper functions: `buildPK()`, `buildSK()`, `parseDate()`

**Update File**: `bin/infra.ts`

```typescript
import { DatabaseStack } from "../lib/database-stack";

const databaseStack = new DatabaseStack(app, "DatabaseStack", {});
new InfraStack(app, "InfraStack", {
  ouraDataBucket: ouraStack.ouraDataBucket,
  stravaDataBucket: stravaStack.stravaDataBucket,
  healthDataTable: databaseStack.healthDataTable,
});
```

### 2. Create Utility Functions

**New File**: `lib/dynamodb-helper.ts`

Reusable CRUD operations:
- `putOuraDayData(date, data)`: Write/overwrite Oura data (4 items: SLEEP, READINESS, ACTIVITY, WORKOUT). Uses PutItem which overwrites existing items with the same PK+SK, ensuring only the latest data is kept.
- `putStravaActivity(activity)`: Write single Strava activity (uses activity ID in SK for uniqueness)
- `putStravaSummary(date, summary)`: Write/overwrite daily Strava summary
- `queryByDate(dataSource, date)`: Get all items for a date
- `queryDateRange(dataSource, startDate, endDate)`: Range query (for future)
- `queryByActivityType(type, startDate, endDate)`: Filter by type (for future)
- `batchWriteItems(items)`: Bulk insert for backfill (overwrites existing)

### 3. Update Data Collection Lambdas (Dual-Write)

**Update File**: `lib/save-oura-data.function.ts`

```typescript
// After S3 save (line 111), add:
await saveToDynamoDB(todaysData);

async function saveToDynamoDB(data: OuraApiResponse) {
  const date = new Date().toISOString().split("T")[0];
  try {
    await putOuraDayData(date, data);
    console.log(`Saved to DynamoDB: ${date}`);
  } catch (error) {
    console.error("DynamoDB write failed:", error);
    // Don't fail - S3 write succeeded
  }
}
```

**Update File**: `lib/sync-strava.function.ts`

```typescript
// After S3 save (line 207), add:
await saveToDynamoDB(dayData);

async function saveToDynamoDB(dayData: StravaDayData) {
  try {
    for (const activity of dayData.activities) {
      await putStravaActivity(activity);
    }
    await putStravaSummary(dayData.date, dayData.summary);
  } catch (error) {
    console.error("DynamoDB write failed:", error);
  }
}
```

**Update Files**: `lib/oura-stack.ts` and `lib/strava-stack.ts`

Add optional `healthDataTable` prop, grant write permissions:

```typescript
interface OuraStackProps extends StackProps {
  healthDataTable?: Table;
}

// In constructor:
if (props?.healthDataTable) {
  saveOuraDataFunction.addEnvironment(
    "TABLE_NAME",
    props.healthDataTable.tableName
  );
  props.healthDataTable.grantWriteData(saveOuraDataFunction);
}
```

### 4. Create Backfill Script

**New File**: `lib/backfill-s3-to-dynamodb.function.ts`

One-time Lambda to migrate historical S3 data:
1. For each day in the last 90 days:
   - List S3 objects for that day (e.g., `oura-data-2026-02-04-*.json`)
   - Find the **latest hourly file** (highest hour number, e.g., `-23.json`)
   - Download and transform to DynamoDB format
2. Batch write to DynamoDB (25 items per request)
3. Log progress and errors

**Note**: We only import the latest file per day since earlier hourly snapshots are superseded by later ones. This keeps backfill fast and storage minimal.

### 5. Update Data Fetch Lambdas (Dual-Read)

**Update File**: `lib/fetch-oura-data.function.ts`

```typescript
async function fetchData(date: string): Promise<any> {
  const dataSource = process.env.DATA_SOURCE || "dynamodb";

  if (dataSource === "dynamodb") {
    try {
      return await fetchFromDynamoDB(date);
    } catch (error) {
      console.warn("DynamoDB read failed, falling back to S3:", error);
      return await fetchFromS3(date);
    }
  }
  return await fetchFromS3(date);
}

async function fetchFromDynamoDB(date: string): Promise<any> {
  const items = await queryByDate("OURA", date);

  if (items.length === 0) {
    throw new Error(`No data found for date: ${date}`);
  }

  // Transform DynamoDB items back to current API format
  return {
    readiness: items.find(i => i.itemType === "READINESS")?.data || {},
    sleep: items.find(i => i.itemType === "SLEEP")?.data || {},
    activity: items.find(i => i.itemType === "ACTIVITY")?.data || {},
    workout: items.find(i => i.itemType === "WORKOUT")?.data || {},
  };
}
```

**Update File**: `lib/get-strava.function.ts`

Same dual-read pattern, transform items to `StravaDayData` format.

**Update File**: `lib/infra-stack.ts`

```typescript
interface InfraStackProps extends StackProps {
  ouraDataBucket: Bucket;
  stravaDataBucket: Bucket;
  healthDataTable?: Table;
}

// Grant read permissions to fetch functions
if (props.healthDataTable) {
  fetchOuraDataFunction.addEnvironment("TABLE_NAME", props.healthDataTable.tableName);
  props.healthDataTable.grantReadData(fetchOuraDataFunction);

  fetchStravaDataFunction.addEnvironment("TABLE_NAME", props.healthDataTable.tableName);
  props.healthDataTable.grantReadData(fetchStravaDataFunction);
}
```

### 6. Update Dependencies

**Update File**: `package.json`

```json
"dependencies": {
  "@aws-sdk/client-dynamodb": "^3.948.0",
  "@aws-sdk/lib-dynamodb": "^3.948.0"
}
```

Run: `npm install`

## Deployment Sequence

### Day 1: Deploy Database and Backfill

```bash
# Build and deploy
npm run build
cdk deploy DatabaseStack

# Trigger backfill (90 days)
aws lambda invoke \
  --function-name DatabaseStack-backfill-s3-to-dynamodb \
  --payload '{"startDate": "2025-11-06", "endDate": "2026-02-04"}' \
  response.json

# Monitor progress (~15 minutes)
aws logs tail /aws/lambda/DatabaseStack-backfill-s3-to-dynamodb --follow

# Verify data in DynamoDB
aws dynamodb query \
  --table-name HealthDataTable \
  --key-condition-expression "PK = :pk" \
  --expression-attribute-values '{":pk":{"S":"OURA#2026-02-04"}}'
```

### Day 2: Deploy Dual-Write Sync Lambdas

```bash
# Deploy updated sync functions
cdk deploy OuraStack
cdk deploy StravaStack

# Manually trigger to verify dual-write works
aws lambda invoke \
  --function-name OuraStack-save-oura-data \
  response.json

# Check both S3 and DynamoDB have today's data
aws s3 ls s3://ourastack-ouradata-*/
aws dynamodb query \
  --table-name HealthDataTable \
  --key-condition-expression "PK = :pk" \
  --expression-attribute-values '{":pk":{"S":"OURA#2026-02-05"}}'
```

### Day 3: Monitor Dual-Write

```bash
# Wait for hourly cron jobs to run naturally
# Monitor CloudWatch logs for errors
aws logs tail /aws/lambda/OuraStack-save-oura-data --follow
aws logs tail /aws/lambda/StravaStack-sync-strava --follow

# Verify writes to both systems are succeeding
```

### Day 4: Deploy Dual-Read Fetch Lambdas

```bash
# Deploy updated fetch functions (DynamoDB with S3 fallback)
cdk deploy InfraStack

# Test API endpoints
curl https://fhudson.com/api/oura
curl https://fhudson.com/api/strava/2026-02-04

# Monitor Lambda duration (should drop from ~200ms to ~50ms)
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Duration \
  --dimensions Name=FunctionName,Value=InfraStack-fetch-oura-data \
  --start-time 2026-02-06T00:00:00Z \
  --end-time 2026-02-06T23:59:59Z \
  --period 300 \
  --statistics Average
```

### Day 5: Remove S3 Write Logic

```bash
# Update sync Lambdas to DynamoDB-only
# (Manually remove S3 write code from functions)
npm run build
cdk deploy OuraStack
cdk deploy StravaStack

# Remove S3 fallback from fetch Lambdas
# (Update DATA_SOURCE env var to "dynamodb")
cdk deploy InfraStack

# Final verification
curl https://fhudson.com/api/oura
curl https://fhudson.com/api/strava
```

## Testing and Verification

### Unit Tests

Create `test/database.test.ts`:
- Test `buildPK()`, `buildSK()` key generation
- Test `putOuraDayData()` creates correct items
- Test `queryByDate()` retrieves all items for a date
- Mock DynamoDB client responses

### Integration Tests

Create `test/integration.test.ts`:
- Write Oura data via sync Lambda, read via fetch Lambda
- Write Strava data, verify in DynamoDB
- Test S3 fallback when DynamoDB returns no data
- Test API endpoints return correct format

### Performance Metrics

Track in CloudWatch:

| Metric | S3 Baseline | DynamoDB Target |
|--------|-------------|-----------------|
| Read latency | 150-200ms | <50ms |
| Write latency | 100-150ms | <30ms |
| API cached response | ~200ms | ~200ms (no change) |
| Lambda errors | Near zero | Near zero |

### Manual Test Script

```bash
#!/bin/bash
# Test 1: Trigger sync
aws lambda invoke --function-name OuraStack-save-oura-data response.json

# Test 2: Query DynamoDB
DATE=$(date +%Y-%m-%d)
aws dynamodb query \
  --table-name HealthDataTable \
  --key-condition-expression "PK = :pk" \
  --expression-attribute-values "{\":pk\":{\"S\":\"OURA#$DATE\"}}"

# Test 3: API endpoint
curl https://fhudson.com/api/oura

# Test 4: Check CloudWatch metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Duration \
  --dimensions Name=FunctionName,Value=InfraStack-fetch-oura-data \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%S)Z \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S)Z \
  --period 60 \
  --statistics Average
```

## Rollback Strategy

### Immediate Rollback (If Critical Issues)

```bash
# Force S3 reads via environment variable
aws lambda update-function-configuration \
  --function-name InfraStack-fetch-oura-data \
  --environment Variables="{DATA_SOURCE=s3,TABLE_NAME=HealthDataTable}"

aws lambda update-function-configuration \
  --function-name InfraStack-get-strava-data \
  --environment Variables="{DATA_SOURCE=s3,TABLE_NAME=HealthDataTable}"

# Invalidate CloudFront cache
aws cloudfront create-invalidation \
  --distribution-id E1234567890ABC \
  --paths "/api/oura*" "/api/strava*"
```

**Recovery time**: <5 minutes

### Full Rollback

```bash
# Disable DynamoDB writes
cdk deploy OuraStack --context enableDynamoDB=false
cdk deploy StravaStack --context enableDynamoDB=false

# Switch reads back to S3
cdk deploy InfraStack --context dataSource=s3

# Delete database (after verification)
cdk destroy DatabaseStack
```

**Data loss risk**: None - S3 data remains intact throughout migration

## Post-Migration Enhancements (Future Phase)

After migration stabilizes, add advanced query features:

### Enhanced API Endpoints

```typescript
// Date range queries
GET /api/oura?from=2026-01-01&to=2026-02-04

// Activity type filtering
GET /api/strava?type=Run&from=2026-01-01&to=2026-02-04

// Metric filtering
GET /api/oura?score_min=80&date=2026-02-04
```

**Implementation**: Use GSI1 for date range queries, GSI2 for activity type filtering. Add query parameter parsing to fetch functions.

## Cost Impact

| Component | Before (S3) | After (DynamoDB) |
|-----------|-------------|------------------|
| Storage | $0.10/month (17,520 files/year) | <$0.50/month (~1,500 items/year) |
| Reads | $0.02/month | $0.0003/month |
| Writes | $0.01/month | $0.01/month |
| Total | **$0.13/month** | **<$1/month** |

**Storage reduction**: Oura data drops from 24 files/day to 4 records/day (overwrite pattern). Strava stores 1 record per activity + 1 summary per day.

**Value gained**:
- 75% faster queries (200ms → 50ms)
- Date range queries (previously impossible)
- Activity type filtering (previously impossible)
- No data duplication (always latest version)
- Foundation for analytics and trends
- Scalable to millions of data points

## Critical Files

**New Files**:
- `lib/database-stack.ts` - DynamoDB table definition
- `lib/database-types.ts` - TypeScript interfaces
- `lib/dynamodb-helper.ts` - CRUD operations
- `lib/backfill-s3-to-dynamodb.function.ts` - Historical data migration
- `test/database.test.ts` - Unit tests
- `test/integration.test.ts` - E2E tests

**Modified Files**:
- `bin/infra.ts` - Add DatabaseStack
- `lib/save-oura-data.function.ts` - Add DynamoDB write
- `lib/sync-strava.function.ts` - Add DynamoDB write
- `lib/fetch-oura-data.function.ts` - Add DynamoDB read with S3 fallback
- `lib/get-strava.function.ts` - Add DynamoDB read with S3 fallback
- `lib/oura-stack.ts` - Grant DB permissions
- `lib/strava-stack.ts` - Grant DB permissions
- `lib/infra-stack.ts` - Pass table to fetch Lambdas
- `package.json` - Add DynamoDB SDK dependencies

## Success Criteria

- ✅ All historical data (90 days) migrated to DynamoDB (latest snapshot per day)
- ✅ Hourly sync jobs overwrite DynamoDB records with latest data
- ✅ API endpoints return correct data from DynamoDB
- ✅ Query latency reduced from 200ms to <50ms
- ✅ Zero data loss or API errors during migration
- ✅ CloudFront caching continues to work (no user-facing changes)
- ✅ S3 fallback works if DynamoDB issues arise
- ✅ No data duplication (one record per day per data type for Oura)
