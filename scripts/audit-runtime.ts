import { spawnSync } from 'node:child_process';

interface AuditAdvisory {
  severity?: string;
  title?: string;
}

type AuditOutput = Record<string, AuditAdvisory[]>;

const audit = spawnSync('bun', ['audit', '--json'], {
  encoding: 'utf8',
  env: process.env,
});

if (!audit.stdout.trim()) {
  process.stderr.write(audit.stderr);
  process.exit(audit.status ?? 1);
}

const report = JSON.parse(audit.stdout) as AuditOutput;
const advisories = Object.entries(report).flatMap(([packageName, entries]) =>
  entries.map((advisory) => ({ ...advisory, packageName })),
);
const blocking = advisories.filter((advisory) =>
  ['critical', 'high'].includes(advisory.severity ?? ''),
);

if (blocking.length > 0) {
  for (const advisory of blocking) {
    console.error(
      `${advisory.severity ?? 'unknown'}: ${advisory.packageName} - ${advisory.title ?? 'security advisory'}`,
    );
  }
  process.exit(1);
}

console.log(
  `No high or critical dependency advisories found (${advisories.length} lower-severity advisories).`,
);
