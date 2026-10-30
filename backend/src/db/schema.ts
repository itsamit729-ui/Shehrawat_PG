import type { ColumnType, Generated } from "kysely";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type RequiredTimestamp = ColumnType<Date, Date | string, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json<T> = ColumnType<T, string, string>;
// mysql2 returns BIGINT as a number while it is a safe integer, which any paise amount here is.
type Paise = ColumnType<number, number, number>;

export type Role = "owner" | "resident" | "corporate";
export type UserStatus = "invited" | "active" | "disabled";
export type Sharing = "single" | "double" | "triple";
export type ResidentStatus = "Active" | "Notice" | "Moved out";

export interface Database {
  businesses: {
    id: string;
    slug: string;
    name: string;
    timezone: Generated<string>;
    created_at: Timestamp;
  };
  users: {
    id: string;
    business_id: string;
    role: Role;
    status: Generated<UserStatus>;
    name: string;
    email: string | null;
    phone: string | null;
    password_hash: string | null;
    last_login_at: NullableTimestamp;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  sessions: {
    token_hash: string;
    user_id: string;
    created_at: Timestamp;
    last_seen_at: Timestamp;
    idle_expires_at: RequiredTimestamp;
    absolute_expires_at: RequiredTimestamp;
    revoked_at: NullableTimestamp;
  };
  otp_challenges: {
    id: string;
    user_id: string;
    code_hmac: string;
    attempts: Generated<number>;
    created_at: Timestamp;
    expires_at: RequiredTimestamp;
    consumed_at: NullableTimestamp;
    invalidated_at: NullableTimestamp;
  };
  password_tokens: {
    token_hash: string;
    user_id: string;
    purpose: "invite" | "recovery";
    created_at: Timestamp;
    expires_at: RequiredTimestamp;
    used_at: NullableTimestamp;
  };
  rate_limits: {
    key_hash: string;
    window_started_at: RequiredTimestamp;
    window_seconds: number;
    hits: number;
  };
  audit_events: {
    id: string;
    business_id: string;
    actor_user_id: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    request_id: string | null;
    metadata: Json<unknown> | null;
    created_at: Timestamp;
  };
  idempotency_keys: {
    actor: string;
    endpoint: string;
    idempotency_key: string;
    payload_hash: string;
    response: Json<unknown> | null;
    created_at: Timestamp;
  };
  jobs: {
    id: string;
    kind: string;
    dedupe_key: string;
    payload: Json<unknown>;
    state: Generated<"queued" | "running" | "done" | "dead">;
    run_at: RequiredTimestamp;
    attempts: Generated<number>;
    max_attempts: Generated<number>;
    lease_expires_at: NullableTimestamp;
    last_error: string | null;
    created_at: Timestamp;
    finished_at: NullableTimestamp;
  };
  properties: {
    id: string;
    business_id: string;
    name: string;
    area: string;
    sector: string;
    gender: string;
    audience: string;
    food: number;
    ac: number;
    rating: ColumnType<string, number, number>;
    reviews: number;
    img: string;
    gallery: Json<string[]>;
    landmarks: Json<string[][]>;
    amenities: Json<string[]>;
    blurb: string;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  property_rates: {
    property_id: string;
    sharing: Sharing;
    monthly_rent_paise: Paise;
  };
  rooms: {
    id: string;
    business_id: string;
    property_id: string;
    code: string;
    sharing: Sharing;
  };
  beds: {
    id: string;
    business_id: string;
    room_id: string;
    code: string;
    active: Generated<number>;
    blocked: Generated<number>;
  };
  corporate_accounts: {
    id: string;
    business_id: string;
    name: string;
    created_at: Timestamp;
  };
  corporate_memberships: {
    user_id: string;
    corporate_id: string;
    created_at: Timestamp;
  };
  resident_profiles: {
    id: string;
    business_id: string;
    user_id: string;
    corporate_id: string | null;
    property_id: string;
    room_label: string;
    monthly_rent_paise: Paise;
    status: ResidentStatus;
    joined_on: string;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  bookings: {
    id: string;
    business_id: string;
    resident_id: string | null;
    state: "held" | "expired" | "cancelled" | "confirmed" | "payment_review" | "occupied" | "checked_out";
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  holds: {
    id: string;
    business_id: string;
    booking_id: string;
    state: Generated<"active" | "expired" | "cancelled" | "converted">;
    amount_paise: Paise;
    created_at: Timestamp;
    expires_at: ColumnType<Date, unknown, Date | string>;
  };
  bed_allocations: {
    id: string;
    business_id: string;
    bed_id: string;
    booking_id: string;
    hold_id: string | null;
    state: "held" | "confirmed" | "occupied" | "released" | "checked_out";
    hold_expires_at: ColumnType<Date | null, unknown, Date | string | null>;
    stay_start: string;
    stay_end: string | null;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
}
