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
export interface AdminUser {
  id: string;
  email: string | null;
  display_name: string | null;
  status: 'active' | 'deleting' | 'deleted';
  created_at: string;
  plan: 'free' | 'pro';
  active_device_count: number;
  last_device_seen_at: string | null;
}
export interface AdminUsers {
  users: AdminUser[];
  nextCursor: string | null;
}
export interface CampaignCreated {
  id: string;
  secret: string;
  link?: string;
}
