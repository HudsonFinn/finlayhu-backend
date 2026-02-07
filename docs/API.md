# fhudson.com API Documentation

Base URL: `https://fhudson.com`

All endpoints are publicly accessible (no authentication required).

## Oura Ring API

Health and fitness data from Oura Ring including sleep, readiness, activity, and workout metrics.

### Get Single Date

```
GET /api/oura
GET /api/oura/{date}
```

**Parameters:**
- `date` (path, optional): Date in YYYY-MM-DD format. Defaults to today.

**Response:**
```json
{
  "date": "2026-02-07",
  "data": {
    "sleep": { ... },
    "readiness": { ... },
    "activity": { ... },
    "workout": { ... }
  }
}
```

**Example:**
```bash
curl https://fhudson.com/api/oura
curl https://fhudson.com/api/oura/2026-02-07
```

### Get Date Range

```
GET /api/oura?start={startDate}&end={endDate}
```

**Parameters:**
- `start` (query, required): Start date in YYYY-MM-DD format
- `end` (query, required): End date in YYYY-MM-DD format

**Constraints:**
- Maximum range: 90 days
- Start date must be before or equal to end date

**Response:**
```json
{
  "start": "2026-02-01",
  "end": "2026-02-07",
  "dates": {
    "2026-02-01": {
      "sleep": { ... },
      "readiness": { ... },
      "activity": { ... },
      "workout": { ... }
    },
    "2026-02-02": { ... },
    "2026-02-07": { ... }
  }
}
```

**Example:**
```bash
curl "https://fhudson.com/api/oura?start=2026-02-01&end=2026-02-07"
```

---

## Strava API

Running and cycling activity data from Strava including distance, time, elevation, heart rate, and segment efforts.

### Get Single Date

```
GET /api/strava
GET /api/strava/{date}
```

**Parameters:**
- `date` (path, optional): Date in YYYY-MM-DD format. Defaults to today.

**Response:**
```json
{
  "date": "2026-02-07",
  "fetched_at": "2026-02-07T15:00:00.000Z",
  "activities": [
    {
      "id": 12345678901,
      "name": "Morning Run",
      "type": "Run",
      "distance": 5000,
      "moving_time": 1800,
      "elapsed_time": 1850,
      "total_elevation_gain": 45,
      "average_speed": 2.78,
      "max_speed": 3.5,
      "average_heartrate": 145,
      "max_heartrate": 165,
      "start_date": "2026-02-07T07:00:00Z",
      "start_date_local": "2026-02-07T07:00:00",
      "segment_efforts": [ ... ]
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

**Example:**
```bash
curl https://fhudson.com/api/strava
curl https://fhudson.com/api/strava/2026-02-07
```

### Get Date Range

```
GET /api/strava?start={startDate}&end={endDate}
GET /api/strava?start={startDate}&end={endDate}&type={activityType}
```

**Parameters:**
- `start` (query, required): Start date in YYYY-MM-DD format
- `end` (query, required): End date in YYYY-MM-DD format
- `type` (query, optional): Filter by activity type (e.g., "Run", "Ride", "Swim")

**Constraints:**
- Maximum range: 90 days
- Start date must be before or equal to end date

**Response:**
```json
{
  "start": "2026-02-01",
  "end": "2026-02-07",
  "activities": [
    {
      "id": 12345678901,
      "name": "Morning Run",
      "type": "Run",
      "date": "2026-02-07",
      "distance": 5000,
      "moving_time": 1800,
      "total_elevation_gain": 45,
      "average_heartrate": 145
    },
    {
      "id": 12345678900,
      "name": "Evening Ride",
      "type": "Ride",
      "date": "2026-02-06",
      "distance": 25000,
      "moving_time": 3600,
      "total_elevation_gain": 150,
      "average_heartrate": 135
    }
  ],
  "summary": {
    "total_distance": 30000,
    "total_moving_time": 5400,
    "total_elevation": 195,
    "activity_count": 2,
    "types": { "Run": 1, "Ride": 1 }
  }
}
```

**Examples:**
```bash
# Get all activities for February 2026
curl "https://fhudson.com/api/strava?start=2026-02-01&end=2026-02-28"

# Get only runs for the past week
curl "https://fhudson.com/api/strava?start=2026-02-01&end=2026-02-07&type=Run"

# Get only bike rides
curl "https://fhudson.com/api/strava?start=2026-01-01&end=2026-02-07&type=Ride"
```

---

## Quote of the Day API

```
GET /api/qotd
```

Returns a daily inspirational quote.

**Response:**
```json
{
  "quote": "The only way to do great work is to love what you do.",
  "author": "Steve Jobs"
}
```

---

## Error Responses

### 400 Bad Request

Returned when request parameters are invalid.

```json
{
  "error": "Invalid date format. Use YYYY-MM-DD format (e.g., 2026-02-07)"
}
```

```json
{
  "error": "Both 'start' and 'end' query parameters are required for range queries"
}
```

```json
{
  "error": "Start date must be before or equal to end date"
}
```

```json
{
  "error": "Date range cannot exceed 90 days. Requested: 120 days"
}
```

### 404 Not Found

Returned when no data exists for the requested date.

```json
{
  "error": "No Strava data found for 2026-02-07",
  "date": "2026-02-07"
}
```

### 500 Internal Server Error

Returned when an unexpected error occurs.

```json
{
  "error": "Failed to fetch Strava data",
  "message": "DynamoDB query failed"
}
```

---

## Caching

Responses are cached at the CloudFront edge:

| Endpoint | Cache TTL |
|----------|-----------|
| `/api/qotd` | 24 hours |
| `/api/oura*` | 1 hour |
| `/api/strava*` | 30 minutes |

Query parameters (start, end, type) are included in the cache key, so different parameter combinations are cached separately.

---

## Rate Limits

These APIs use CloudFront caching and have no explicit rate limits. However, please be respectful with request frequency. Data is synced hourly, so there's no benefit to polling more frequently.

---

## Data Freshness

- **Oura data**: Synced hourly from Oura Cloud API
- **Strava data**: Synced hourly from Strava API

For single-date queries, if data is not found in DynamoDB, the API falls back to S3 storage for historical data. Range queries only use DynamoDB (no S3 fallback).

---

## Activity Types (Strava)

Common activity types for the `type` filter:
- `Run`
- `Ride`
- `Swim`
- `Walk`
- `Hike`
- `Workout`
- `WeightTraining`
- `Yoga`

See [Strava API documentation](https://developers.strava.com/docs/reference/#api-models-ActivityType) for the complete list.
