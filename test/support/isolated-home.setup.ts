import { homedir } from 'node:os';
import { ISOLATED_HOME_ENV } from './isolated-home.global-setup.js';

const isolated = process.env[ISOLATED_HOME_ENV];

if (!isolated || homedir() !== isolated) {
  throw new Error(
    `Tests must run with HOME set to the isolated temp home (${isolated ?? 'unset'}), but os.homedir() is ${homedir()}. ` +
      'Run through jest.config.ts so globalSetup redirects HOME; the real ~/.newrelic-preflight must never be written by tests.',
  );
}
