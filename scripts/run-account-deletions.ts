import { runAccountDeletionBatch } from '../src/services/account-deletion.js';
import { writeLog } from '../src/lib/logger.js';

const result = await runAccountDeletionBatch(25);
writeLog('info', 'account_deletions.completed', result);
