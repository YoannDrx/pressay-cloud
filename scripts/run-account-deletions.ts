import { runAccountDeletionBatch } from '../src/services/account-deletion.ts';

const result = await runAccountDeletionBatch(25);
console.log(JSON.stringify({ event: 'account_deletions.completed', ...result }));
