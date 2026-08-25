import { auditStripeCatalogue } from '../src/billing/catalog-audit.js';

const audit = await auditStripeCatalogue();
console.log(
  JSON.stringify({
    status: 'verified',
    account: audit.accountId,
    product: audit.productId,
    prices: 2,
    currency: audit.currency,
    taxReady: audit.taxReady,
    portalConfiguration: audit.portalConfigurationId,
  }),
);
