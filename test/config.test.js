/* eslint-disable no-console */
const assert = require('node:assert/strict');

const CONFIG_PATH = require.resolve('../src/config');

function loadFreshConfig() {
  delete require.cache[CONFIG_PATH];
  return require('../src/config');
}

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === null || value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

(function main() {
  try {
    withEnv(
      {
        NODE_ENV: 'production',
        API_TOKEN: 'token',
        DEFAULT_EXECUTION_MODE: 'oz',
        WARP_API_KEY: null,
      },
      () => {
        const config = loadFreshConfig();
        assert.throws(() => config.validateForBoot(), /DEFAULT_EXECUTION_MODE=oz requires WARP_API_KEY/);
        console.log('[ok] production oz default requires WARP_API_KEY');
      },
    );

    withEnv(
      {
        NODE_ENV: 'production',
        API_TOKEN: 'token',
        DEFAULT_EXECUTION_MODE: 'webhook',
        DISPATCH_WEBHOOK_URL: null,
      },
      () => {
        const config = loadFreshConfig();
        assert.throws(() => config.validateForBoot(), /DEFAULT_EXECUTION_MODE=webhook requires DISPATCH_WEBHOOK_URL/);
        console.log('[ok] production webhook default requires DISPATCH_WEBHOOK_URL');
      },
    );

    withEnv(
      {
        NODE_ENV: 'production',
        API_TOKEN: 'token',
        DEFAULT_EXECUTION_MODE: 'miguel',
        MIGUEL_DISPATCH_ORDER: 'oz,webhook',
        MIGUEL_LOCAL_FALLBACK: 'false',
        WARP_API_KEY: null,
        DISPATCH_WEBHOOK_URL: null,
      },
      () => {
        const config = loadFreshConfig();
        assert.throws(() => config.validateForBoot(), /DEFAULT_EXECUTION_MODE=miguel requires at least one reachable target/);
        console.log('[ok] production miguel default requires at least one configured target');
      },
    );

    withEnv(
      {
        NODE_ENV: 'production',
        API_TOKEN: 'token',
        DEFAULT_EXECUTION_MODE: 'miguel',
        MIGUEL_DISPATCH_ORDER: 'oz,webhook,local',
        MIGUEL_LOCAL_FALLBACK: 'true',
        WARP_API_KEY: null,
        DISPATCH_WEBHOOK_URL: null,
      },
      () => {
        const config = loadFreshConfig();
        assert.equal(config.validateForBoot(), true);
        console.log('[ok] production miguel default passes when at least one target is available');
      },
    );

    console.log('\nALL CONFIG TESTS PASSED');
    process.exit(0);
  } catch (err) {
    console.error('TEST FAILURE:', err);
    process.exit(1);
  }
})();
