import type { DownloadEvent } from '../contracts/downloads.js';
import { getSql } from '../db/client.js';

/** Idempotent on the anonymous identifier: a retried report is counted once. */
export async function recordDownloadEvent(event: DownloadEvent): Promise<void> {
  await getSql().query(
    `INSERT INTO download_event
      (id, platform, asset_type, app_version, source, campaign, referral_code)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (id) DO NOTHING`,
    [
      event.anonymousID,
      event.platform,
      event.assetType,
      event.appVersion,
      event.source,
      event.campaign ?? null,
      event.referralCode ?? null,
    ],
  );
}
