export interface AppVariables {
  requestId: string;
  authUserId: string;
  authEmail: string;
  authEmailVerified: boolean;
  authStepUpAt: number;
  authSignedInAt: number;
  authTwoFactor: boolean;
  authSessionId: string;
  authWebProxy: boolean;
  operationsAccountId: string;
  operationsRole: 'owner' | 'support' | 'readonly';
}

export interface AppEnvironment {
  Variables: AppVariables;
}
