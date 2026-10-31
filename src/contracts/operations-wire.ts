// Shared web/Cloud wire contract v1. Copy verbatim with scripts/sync-web-contract.ts.
export interface CampaignInput {
  idempotencyKey: string;
  reason: string;
  kind: 'access_grant' | 'stripe_discount';
  delivery: 'code' | 'link';
  durationDays: number;
  maxRedemptions: number;
  restrictedEmail?: string | undefined;
  expiresAt?: string | undefined;
  discountPercent?: number | undefined;
  discountAmount?: number | undefined;
}
export type RewardStatus =
  'pending' | 'processing' | 'applied' | 'failed' | 'cancelled' | 'review';
export interface ReferralSummary {
  link: string;
  signups: number;
  conversions: number;
  rewards: {
    id: string;
    side: 'referrer' | 'referee';
    status: RewardStatus;
    kind: 'credit' | 'grant' | 'apple_ineligible' | null;
    amount_minor: number | null;
    currency: string | null;
    applied_at: string | null;
    last_error_code: string | null;
  }[];
}
// Fields added after v1 are optional so a site deployed before or after the
// API keeps rendering while the other side catches up.
export type AdminPlan = 'free' | 'pro' | 'sandbox';
export type AdminUserSearchKind =
  | 'none'
  | 'text'
  | 'uuid'
  | 'stripe_customer'
  | 'stripe_subscription'
  | 'apple_transaction';
export type EntitlementSource = 'none' | 'trial' | 'stripe' | 'app_store' | 'support';
export interface AdminUser {
  id: string;
  email: string | null;
  display_name: string | null;
  status: 'active' | 'deleting' | 'deleted';
  created_at: string;
  plan: AdminPlan;
  entitlement_source?: EntitlementSource;
  sandbox?: boolean;
  active_device_count: number;
  macos_device_count?: number;
  windows_device_count?: number;
  last_device_seen_at: string | null;
}
export interface AdminUsers {
  users: AdminUser[];
  nextCursor: string | null;
  searchKind?: AdminUserSearchKind;
}
export interface AdminDevice {
  id: string;
  displayName: string;
  platform?: 'macos' | 'windows';
  appVariant: 'direct' | 'mas';
  appVersion: string;
  approved?: boolean;
  lastSeenAt: string;
  createdAt?: string;
  revokedAt?: string | null;
}
export interface AdminSubscription {
  provider: 'stripe' | 'app_store';
  provider_subscription_id?: string;
  provider_product_id?: string;
  status: string;
  billing_interval: 'month' | 'year';
  trial_ends_at?: string | null;
  current_period_starts_at?: string | null;
  current_period_ends_at: string | null;
  cancel_at_period_end?: boolean;
  grace_ends_at?: string | null;
  apple_environment: 'Production' | 'Sandbox';
  created_at?: string;
  updated_at?: string;
}
export interface AdminFinancialEvent {
  provider_event_id: string;
  provider_object_id: string;
  provider_subscription_id: string | null;
  kind: 'invoice_paid' | 'invoice_failed' | 'invoice_voided' | 'refund' | 'dispute';
  status: string;
  amount_minor: number;
  currency: string;
  full_reversal: boolean;
  provider_occurred_at: string;
}
export interface AdminAuditEntry {
  id: string;
  actor_id: string | null;
  action: string;
  target_id: string;
  reason: string;
  result: string;
  request_id: string;
  created_at: string;
}
export interface AdminUserDetail {
  account: {
    accountId: string;
    authUserId?: string;
    email: string | null;
    status: 'active' | 'deleting' | 'deleted';
    createdAt: string;
    deletionRequestedAt?: string | null;
    entitlement: {
      tier: 'free' | 'pro';
      source: EntitlementSource;
      validFrom: string;
      validUntil: string | null;
      offlineGraceUntil: string | null;
      revision: number;
      sandbox?: boolean;
    };
  };
  billingCustomer?: {
    stripeCustomerId: string | null;
    appStoreOriginalTransactionId: string | null;
    stripeMode: 'live' | 'test';
  };
  usage: {
    transcription: { usedSeconds: number };
    transformations: { used: number };
  };
  usageHistory?: {
    period_start: string;
    transcription_seconds_used: number;
    transformations_used: number;
  }[];
  devices: AdminDevice[];
  subscriptions: AdminSubscription[];
  financialEvents?: AdminFinancialEvent[];
  legalAcceptances?: {
    terms_version: string;
    immediate_performance_consent: boolean;
    accepted_at: string;
  }[];
  deletion?: {
    state: 'queued' | 'processing' | 'completed' | 'failed';
    attempts: number;
    next_attempt_at: string;
    last_error_code: string | null;
    created_at: string;
    completed_at: string | null;
  } | null;
  grants: {
    id: string;
    source: string;
    starts_at?: string;
    ends_at: string;
    revoked_at: string | null;
  }[];
  referrals: {
    id: string;
    referrer_id: string;
    referee_id: string;
    status: string;
    attributed_at?: string;
  }[];
  audit?: AdminAuditEntry[];
  auditReads?: { count: number; lastAt: string | null };
}
export interface CampaignCreated {
  id: string;
  secret: string;
  link?: string;
}
