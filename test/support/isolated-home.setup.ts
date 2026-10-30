import { homedir } from 'node:os';

const isolated = process.env.PREFLIGHT_TEST_ISOLATED_HOME;

if (!isolated || homedir() !== isolated) {
  throw new Error(
    `Tests must run with HOME set to the isolated temp home (${isolated ?? 'unset'}), but os.homedir() is ${homedir()}. ` +
      'Run through jest.config.ts so globalSetup redirects HOME; the real ~/.newrelic-preflight must never be written by tests.',
  );
}
