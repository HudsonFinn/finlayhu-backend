export interface StravaActivity {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  start_date: string;
  start_date_local: string;
  timezone: string;
  average_speed: number;
  max_speed: number;
  average_heartrate?: number;
  max_heartrate?: number;
  calories?: number;
  suffer_score?: number;
  segment_efforts?: StravaSegmentEffort[];
  device_name?: string;
}

export interface StravaSegmentEffort {
  id: number;
  name: string;
  elapsed_time: number;
  moving_time: number;
  start_date: string;
  distance: number;
  average_heartrate?: number;
  max_heartrate?: number;
  pr_rank?: number;
  achievements?: Array<{
    type_id: number;
    type: string;
    rank: number;
  }>;
}

export interface StravaTokenResponse {
  token_type: string;
  expires_at: number;
  expires_in: number;
  refresh_token: string;
  access_token: string;
}

export interface StravaSecrets {
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
  STRAVA_ACCESS_TOKEN: string;
  STRAVA_REFRESH_TOKEN: string;
  STRAVA_EXPIRES_AT: number;
}

export interface StravaDayData {
  date: string;
  fetched_at: string;
  activities: StravaActivity[];
  summary: {
    total_distance: number;
    total_moving_time: number;
    total_elevation: number;
    activity_count: number;
    types: Record<string, number>;
  };
}
