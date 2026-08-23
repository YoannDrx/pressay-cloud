import { describe, expect, it } from 'vitest';

import { Environment } from '@apple/app-store-server-library';

import { appleVerificationTargetsFor } from '../src/billing/apple-client.ts';

describe('App Store environment boundary', () => {
  it('accepts only Sandbox transactions outside production', () => {
    expect(appleVerificationTargetsFor('development')).toEqual([Environment.SANDBOX]);
    expect(appleVerificationTargetsFor('staging')).toEqual([Environment.SANDBOX]);
  });

  it('accepts only Production transactions in production', () => {
    expect(appleVerificationTargetsFor('production')).toEqual([Environment.PRODUCTION]);
  });
});
