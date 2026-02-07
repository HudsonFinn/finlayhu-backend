// Base item structure for all DynamoDB items
export interface DynamoDBBaseItem {
  PK: string;
  SK: string;
  GSI1PK?: string;
  GSI1SK?: string;
  GSI2PK?: string;
  GSI2SK?: string;
  dataSource: "OURA" | "STRAVA";
  date: string;
  updated_at: string;
  ttl?: number;
}

// Oura data types
export type OuraItemType = "SLEEP" | "READINESS" | "ACTIVITY" | "WORKOUT";

export interface OuraDynamoDBItem extends DynamoDBBaseItem {
  dataSource: "OURA";
  itemType: OuraItemType;
  data: Record<string, unknown>;
}

// Strava data types
export interface StravaDynamoDBActivityItem extends DynamoDBBaseItem {
  dataSource: "STRAVA";
  activityId: number;
  activityType: string;
  data: Record<string, unknown>;
}

export interface StravaDynamoDBSummaryItem extends DynamoDBBaseItem {
  dataSource: "STRAVA";
  data: {
    total_distance: number;
    total_moving_time: number;
    total_elevation: number;
    activity_count: number;
    types: Record<string, number>;
  };
}

// API response structures (matching current S3 format)
export interface OuraApiResponse {
  readiness: Record<string, unknown>;
  sleep: Record<string, unknown>;
  activity: Record<string, unknown>;
  workout: Record<string, unknown>;
}

export interface StravaSummary {
  total_distance: number;
  total_moving_time: number;
  total_elevation: number;
  activity_count: number;
  types: Record<string, number>;
}

// Helper functions for building keys
export function buildOuraPK(date: string): string {
  return `OURA#${date}`;
}

export function buildOuraSK(itemType: OuraItemType): string {
  return itemType;
}

export function buildStravaPK(date: string): string {
  return `STRAVA#${date}`;
}

export function buildStravaActivitySK(activityId: number): string {
  return `ACTIVITY#${activityId}`;
}

export function buildStravaSummarySK(): string {
  return "SUMMARY";
}

// GSI key builders
export function buildOuraGSI1PK(itemType: OuraItemType): string {
  return `OURA#${itemType}`;
}

export function buildStravaGSI1PK(): string {
  return "STRAVA#ACTIVITY";
}

export function buildStravaGSI2PK(activityType: string): string {
  return `STRAVA#TYPE#${activityType}`;
}

// TTL helper (2 years from now in seconds)
export function calculateTTL(): number {
  const twoYearsInSeconds = 2 * 365 * 24 * 60 * 60;
  return Math.floor(Date.now() / 1000) + twoYearsInSeconds;
}
