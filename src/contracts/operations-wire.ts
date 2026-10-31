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
export type AdminAuditDetails = Record<string, string | number | boolean | null>;
export interface AdminAuditEntry {
  id: string;
  actor_id: string | null;
  action: string;
  target_id: string;
  target_account_id?: string | null;
  reason: string;
  result: string;
  request_id: string;
  details?: AdminAuditDetails | null;
  created_at: string;
}
export interface AdminAuditLog {
  entries: (AdminAuditEntry & { actor_email?: string | null })[];
  nextCursor?: string | null;
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
    reason?: string | null;
    created_by?: string | null;
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
  providerEvents?: AdminProviderEvent[];
}
export interface CampaignCreated {
  id: string;
  secret: string;
  link?: string;
}
export interface SupportGrantResult {
  grantId: string;
  accountId: string;
  days: number;
  endsAt: string;
  replayed: boolean;
}
export interface DeviceActionResult {
  deviceId: string;
  accountId: string;
  platform: 'macos' | 'windows';
  changed: boolean;
  replayed: boolean;
}
export type ExternalAuditAction = 'user.sessions.revoke';
export interface ExternalAuditInput {
  idempotencyKey: string;
  reason: string;
  action: ExternalAuditAction;
  targetAccountId: string;
  result: 'requested' | 'succeeded' | 'failed';
  details?: {
    webSessions?: number;
    oauthRefreshTokens?: number;
    oauthAccessTokens?: number;
    errorCode?: string;
  };
}
export interface ExternalAuditRecorded {
  recorded: true;
  authUserId: string;
}
/**
 * Administrator roles: `owner` (everything), `support` (support actions,
 * no billing, no roles), `readonly` (reads only).
 */
export type OperationsRole = 'owner' | 'support' | 'readonly';
export interface AdminSession {
  role: OperationsRole;
  accountId?: string;
}
export interface AdminMember {
  accountId: string;
  /** Web identity subject, to show whether the member has an Authenticator app. */
  authUserId: string;
  email: string | null;
  role: OperationsRole;
  addedBy: string | null;
  addedByEmail: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface AdminMembers {
  members: AdminMember[];
}
export interface MemberChangeResult {
  accountId: string;
  previousRole: OperationsRole | null;
  role: OperationsRole | null;
  changed: boolean;
  replayed: boolean;
}
export interface AdminFinancialEvents {
  events: (AdminFinancialEvent & {
    account_id: string | null;
    email: string | null;
  })[];
  nextCursor: string | null;
}
export interface AdminProviderEvent {
  provider: 'stripe' | 'apple';
  provider_event_id: string;
  event_type: string;
  state: 'received' | 'applied' | 'ignored' | 'failed';
  error_code: string | null;
  received_at: string;
  processed_at?: string | null;
  account_id?: string | null;
}
export interface AdminProviderEvents {
  events: AdminProviderEvent[];
  nextCursor?: string | null;
}
export interface AdminAlerts {
  failed_webhooks: number;
  failed_webhooks_24h: number;
  open_disputes: number;
  unpaid_subscriptions: number;
  duplicate_subscriptions: number;
  refunds_24h: number;
  failed_payments_24h: number;
  checkedAt: string;
}
export interface ProviderEventReplay {
  provider: 'stripe';
  eventId: string;
  state: string;
  errorCode: string | null;
  accountId: string | null;
}
export interface AdminMetrics {
  subscribers: {
    provider: 'stripe' | 'app_store';
    billing_interval: 'month' | 'year';
    status: 'trialing' | 'active' | 'past_due' | 'grace';
    environment: 'Production' | 'Sandbox';
    count: number;
  }[];
  mrr: {
    provider: 'stripe' | 'app_store';
    currency: string;
    mrr_minor: number;
    arr_minor: number;
    subscriptions: number;
    estimated_subscriptions: number;
  }[];
  signups: { day: string; count: number }[];
  activeAccounts: { active_7d: number; active_30d: number };
  grants: { source: string; count: number }[];
  collectedThisMonth: {
    currency: string;
    paid_minor: number;
    refunded_minor: number;
    invoices: number;
  }[];
  downloads: {
    platform: 'macos' | 'windows';
    app_version: string;
    last_7d: number;
    last_30d: number;
  }[];
  generatedAt: string;
}
