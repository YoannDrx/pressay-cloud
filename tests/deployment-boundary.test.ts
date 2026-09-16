import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

function check(
  environment: string,
  ref: string,
  project: string,
  sha = 'a'.repeat(40),
) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/assert-deployment.ts'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        VERCEL_ENV: 'production',
        PRESSAY_DEPLOYMENT_ENV: environment,
        VERCEL_GIT_COMMIT_REF: ref,
        VERCEL_GIT_COMMIT_SHA: sha,
        VERCEL_PROJECT_ID: project,
      },
    },
  );
}

it('allows an immutable candidate only on the canonical staging project', () => {
  expect(
    check('staging', 'codex/acceptance', 'prj_QKq9S0LqVbPQD6qvFZDiVNldSzLE').status,
  ).toBe(0);
  expect(
    check('staging', 'codex/acceptance', 'prj_wjK1Ur48HVNXiNwgoPJKilFoCHem').status,
  ).not.toBe(0);
  expect(
    check('staging', 'codex/acceptance', 'prj_QKq9S0LqVbPQD6qvFZDiVNldSzLE', '').status,
  ).not.toBe(0);
});

it('keeps production pinned to main and its canonical project', () => {
  expect(
    check('production', 'codex/acceptance', 'prj_wjK1Ur48HVNXiNwgoPJKilFoCHem').status,
  ).not.toBe(0);
  expect(
    check('production', 'main', 'prj_QKq9S0LqVbPQD6qvFZDiVNldSzLE').status,
  ).not.toBe(0);
  expect(check('production', 'main', 'prj_wjK1Ur48HVNXiNwgoPJKilFoCHem').status).toBe(
    0,
  );
});
