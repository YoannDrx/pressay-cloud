import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('Apple root trust store', () => {
  it('contains the three Apple roots from the official PKI page', () => {
    const pem = readFileSync(
      new URL('../config/apple-root-ca.pem', import.meta.url),
      'utf8',
    );
    const blocks = pem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    );
    expect(blocks).toHaveLength(3);
    const subjects = (blocks ?? []).map((block) => new X509Certificate(block).subject);
    expect(subjects).toEqual(
      expect.arrayContaining([
        expect.stringContaining('CN=Apple Root CA'),
        expect.stringContaining('CN=Apple Root CA - G2'),
        expect.stringContaining('CN=Apple Root CA - G3'),
      ]),
    );
  });
});
