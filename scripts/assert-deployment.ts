const production = process.env.VERCEL_ENV === 'production';

if (production) {
  const ref = process.env.VERCEL_GIT_COMMIT_REF;
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (ref !== 'main') {
    throw new Error(
      'Production deployments must be created by the Vercel Git integration from main',
    );
  }
  if (!sha || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('Production deployment is missing an immutable Git commit SHA');
  }
}

console.log(
  production
    ? 'Verified immutable main-branch production deployment.'
    : 'Verified non-production deployment boundary.',
);
