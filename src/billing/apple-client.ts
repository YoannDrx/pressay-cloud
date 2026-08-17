import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';

import {
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
  type JWSTransactionDecodedPayload,
  type JWSRenewalInfoDecodedPayload,
  type ResponseBodyV2DecodedPayload,
  type Status,
} from '@apple/app-store-server-library';

import { getEnvironment, requireEnvironmentValue } from '../env.js';

interface AppleRuntime {
  verifier: SignedDataVerifier;
  client?: AppStoreServerAPIClient;
}

export interface VerifiedAppleTransaction {
  environment: Environment.PRODUCTION | Environment.SANDBOX;
  transaction: JWSTransactionDecodedPayload;
}

export interface VerifiedAppleNotification {
  environment: Environment.PRODUCTION | Environment.SANDBOX;
  notification: ResponseBodyV2DecodedPayload;
}

export interface VerifiedAppleSubscriptionStatus {
  status?: Status | number;
  transaction: JWSTransactionDecodedPayload;
  renewal?: JWSRenewalInfoDecodedPayload;
}

let runtimeCache:
  | Partial<Record<Environment.PRODUCTION | Environment.SANDBOX, AppleRuntime>>
  | undefined;

function rootCertificates(): Buffer[] {
  const pem = readFileSync(
    new URL('../../config/apple-root-ca.pem', import.meta.url),
    'utf8',
  );
  const certificates = pem.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
  );
  if (!certificates || certificates.length === 0) {
    throw new Error('Apple root certificates are unavailable');
  }
  return certificates.map((certificate) => new X509Certificate(certificate).raw);
}

function getRuntime(
  target: Environment.PRODUCTION | Environment.SANDBOX,
): AppleRuntime {
  runtimeCache ??= {};
  const existing = runtimeCache[target];
  if (existing) return existing;

  const environment = getEnvironment();
  const bundleId = requireEnvironmentValue(
    environment.APPLE_APP_BUNDLE_IDENTIFIER,
    'APPLE_APP_BUNDLE_IDENTIFIER',
  );
  const appAppleId =
    target === Environment.PRODUCTION ? environment.APP_STORE_APP_APPLE_ID : undefined;
  if (target === Environment.PRODUCTION && !appAppleId) {
    throw new Error('APP_STORE_APP_APPLE_ID is required for production verification');
  }
  const verifier = new SignedDataVerifier(
    rootCertificates(),
    true,
    target,
    bundleId,
    appAppleId,
  );

  let client: AppStoreServerAPIClient | undefined;
  if (
    environment.APP_STORE_PRIVATE_KEY_BASE64 &&
    environment.APP_STORE_KEY_ID &&
    environment.APP_STORE_ISSUER_ID
  ) {
    const signingKey = Buffer.from(
      environment.APP_STORE_PRIVATE_KEY_BASE64,
      'base64',
    ).toString('utf8');
    if (!signingKey.includes('BEGIN PRIVATE KEY')) {
      throw new Error('APP_STORE_PRIVATE_KEY_BASE64 is invalid');
    }
    client = new AppStoreServerAPIClient(
      signingKey,
      environment.APP_STORE_KEY_ID,
      environment.APP_STORE_ISSUER_ID,
      bundleId,
      target,
    );
  }
  const runtime = { verifier, ...(client ? { client } : {}) };
  runtimeCache[target] = runtime;
  return runtime;
}

function verificationTargets(): readonly (
  Environment.PRODUCTION | Environment.SANDBOX
)[] {
  return getEnvironment().APP_STORE_APP_APPLE_ID
    ? [Environment.PRODUCTION, Environment.SANDBOX]
    : [Environment.SANDBOX];
}

export async function verifyAppleTransaction(
  signedTransaction: string,
): Promise<VerifiedAppleTransaction> {
  for (const environment of verificationTargets()) {
    try {
      return {
        environment,
        transaction:
          await getRuntime(environment).verifier.verifyAndDecodeTransaction(
            signedTransaction,
          ),
      };
    } catch {
      // A payload is valid for exactly one Apple environment.
    }
  }
  throw new Error('Apple transaction verification failed');
}

export async function verifyAppleNotification(
  signedPayload: string,
): Promise<VerifiedAppleNotification> {
  for (const environment of verificationTargets()) {
    try {
      return {
        environment,
        notification:
          await getRuntime(environment).verifier.verifyAndDecodeNotification(
            signedPayload,
          ),
      };
    } catch {
      // A payload is valid for exactly one Apple environment.
    }
  }
  throw new Error('Apple notification verification failed');
}

export async function getVerifiedAppleSubscriptionStatuses(
  transactionId: string,
  environment: Environment.PRODUCTION | Environment.SANDBOX,
): Promise<readonly VerifiedAppleSubscriptionStatus[]> {
  const runtime = getRuntime(environment);
  if (!runtime.client) throw new Error('App Store Server API is not configured');
  const response = await runtime.client.getAllSubscriptionStatuses(transactionId);
  const statuses: VerifiedAppleSubscriptionStatus[] = [];
  for (const group of response.data ?? []) {
    for (const latest of group.lastTransactions ?? []) {
      if (!latest.signedTransactionInfo) continue;
      const transaction = await runtime.verifier.verifyAndDecodeTransaction(
        latest.signedTransactionInfo,
      );
      const renewal = latest.signedRenewalInfo
        ? await runtime.verifier.verifyAndDecodeRenewalInfo(latest.signedRenewalInfo)
        : undefined;
      statuses.push({
        transaction,
        ...(latest.status !== undefined ? { status: latest.status } : {}),
        ...(renewal ? { renewal } : {}),
      });
    }
  }
  return statuses;
}

export async function verifyAppleNotificationTransaction(
  signedTransaction: string,
  signedRenewal: string | undefined,
  environment: Environment.PRODUCTION | Environment.SANDBOX,
): Promise<{
  transaction: JWSTransactionDecodedPayload;
  renewal?: JWSRenewalInfoDecodedPayload;
}> {
  const verifier = getRuntime(environment).verifier;
  const transaction = await verifier.verifyAndDecodeTransaction(signedTransaction);
  const renewal = signedRenewal
    ? await verifier.verifyAndDecodeRenewalInfo(signedRenewal)
    : undefined;
  return { transaction, ...(renewal ? { renewal } : {}) };
}

export function clearAppleRuntimeForTests(): void {
  runtimeCache = undefined;
}
