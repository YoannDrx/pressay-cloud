import { getSql } from '../db/client.js';
import { csvField } from '../lib/csv.js';
import {
  adminWaitlistSchema,
  waitlistPlatforms,
  type AdminWaitlist,
  type WaitlistPlatform,
  type WaitlistSignup,
} from '../contracts/waitlist.js';

/**
 * Record a sign-up. A repeated sign-up changes nothing, except that someone
 * who had unsubscribed and signs up again gives a new consent. The caller
 * answers the same way in every case, so the response never reveals whether
 * an address was already on the list.
 */
export async function joinWaitlist(signup: WaitlistSignup): Promise<void> {
  await getSql().query(
    `INSERT INTO waitlist_entry (email, platform, locale, source, consent_at)
    VALUES ($1, $2, $3, $4, now())
    ON CONFLICT (email, platform) DO UPDATE SET
      locale = EXCLUDED.locale,
      source = EXCLUDED.source,
      consent_at = now(),
      unsubscribed_at = NULL,
      updated_at = now()
    WHERE waitlist_entry.unsubscribed_at IS NOT NULL`,
    [signup.email, signup.platform, signup.locale, signup.source],
  );
}

/** Counters per platform and per source. No address. */
export async function waitlistSummary(): Promise<AdminWaitlist> {
  const [platforms, sources] = await Promise.all([
    getSql().query(
      `SELECT p.platform,
        count(w.id) FILTER (WHERE w.unsubscribed_at IS NULL)::int AS subscribed,
        count(w.id) FILTER (WHERE w.unsubscribed_at IS NOT NULL)::int AS unsubscribed,
        count(w.id) FILTER (WHERE w.unsubscribed_at IS NULL AND w.locale='fr')::int AS french,
        count(w.id) FILTER (WHERE w.unsubscribed_at IS NULL AND w.locale='en')::int AS english,
        count(w.id) FILTER (WHERE w.unsubscribed_at IS NULL
          AND w.consent_at>now()-interval '7 days')::int AS last_7d,
        max(w.consent_at) AS last_signup_at
      FROM unnest($1::text[]) AS p(platform)
      LEFT JOIN waitlist_entry w ON w.platform=p.platform
      GROUP BY p.platform ORDER BY p.platform`,
      [waitlistPlatforms],
    ),
    getSql().query(
      `SELECT platform,source,count(*)::int AS count FROM waitlist_entry
      WHERE unsubscribed_at IS NULL GROUP BY 1,2 ORDER BY 1,3 DESC,2`,
      [],
    ),
  ]);
  return adminWaitlistSchema.parse({ platforms, sources });
}

export { csvField };

/** Subscribed entries of one platform, oldest first, as CSV. */
export async function waitlistCsv(
  platform: WaitlistPlatform,
): Promise<{ csv: string; rows: number }> {
  const rows = await getSql().query(
    `SELECT email,platform,locale,source,consent_at,created_at FROM waitlist_entry
    WHERE platform=$1 AND unsubscribed_at IS NULL ORDER BY consent_at,email`,
    [platform],
  );
  const header = 'email,platform,locale,source,consent_at,created_at';
  const lines = rows.map((row) =>
    [
      String(row.email),
      String(row.platform),
      String(row.locale),
      String(row.source),
      new Date(row.consent_at as string).toISOString(),
      new Date(row.created_at as string).toISOString(),
    ]
      .map(csvField)
      .join(','),
  );
  return { csv: `${[header, ...lines].join('\r\n')}\r\n`, rows: rows.length };
}
