export interface AppVariables {
  requestId: string;
  authUserId: string;
  authEmail: string;
  authEmailVerified: boolean;
  authStepUpAt: number;
  authSessionId: string;
  authWebProxy: boolean;
  operationsAccountId: string;
}

export interface AppEnvironment {
  Variables: AppVariables;
}
