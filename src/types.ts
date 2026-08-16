export interface AppVariables {
  requestId: string;
  authUserId: string;
  authEmail: string;
}

export interface AppEnvironment {
  Variables: AppVariables;
}
