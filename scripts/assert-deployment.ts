const production = process.env.VERCEL_ENV === 'production';
const canonicalProjectIds = {
  staging: 'prj_QKq9S0LqVbPQD6qvFZDiVNldSzLE',
  production: 'prj_wjK1Ur48HVNXiNwgoPJKilFoCHem',
} as const;

if (production) {
  const ref = process.env.VERCEL_GIT_COMMIT_REF;
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  const deploymentEnvironment = process.env.PRESSAY_DEPLOYMENT_ENV;
  if (ref !== 'main') {
    throw new Error(
      'Production deployments must be created by the Vercel Git integration from main',
    );
  }
  if (!sha || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('Production deployment is missing an immutable Git commit SHA');
  }
  if (!['staging', 'production'].includes(deploymentEnvironment ?? '')) {
    throw new Error(
      'Canonical deployments must declare PRESSAY_DEPLOYMENT_ENV as staging or production',
    );
  }
  const expectedProjectId =
    canonicalProjectIds[deploymentEnvironment as keyof typeof canonicalProjectIds];
  if (process.env.VERCEL_PROJECT_ID !== expectedProjectId) {
    throw new Error(
      `${deploymentEnvironment} must deploy from its canonical Vercel project`,
    );
  }
}

console.log(
  production
    ? 'Verified immutable main-branch production deployment.'
    : 'Verified non-production deployment boundary.',
);
