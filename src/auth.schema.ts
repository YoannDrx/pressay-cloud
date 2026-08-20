// Better Auth CLI entrypoint. Runtime code must import getAuth from auth.ts instead.
import { getAuth } from './auth.js';

export const auth = getAuth();
