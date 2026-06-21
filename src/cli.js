'use strict';

const { loadConfig } = require('./config');
const { startServer } = require('./server');
const { TokenStore } = require('./token-store');

function run(options = {}) {
  let config;
  try {
    config = loadConfig(options);
  } catch (e) {
    console.error('[ERROR] ' + e.message);
    process.exitCode = 1;
    return null;
  }

  const tokenStore = new TokenStore({
    profiles: config.profiles,
    env: options.env || process.env,
    fetchImpl: options.fetchImpl,
    logger: options.logger || console
  });

  const server = startServer(config, {
    ...options,
    tokenStore
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  return server;
}

module.exports = {
  run
};
