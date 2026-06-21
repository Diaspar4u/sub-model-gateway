'use strict';

const http = require('http');
const {
  CC_VERSION,
  VERSION
} = require('./constants');
const { selectProfile } = require('./profiles');
const { TokenStore } = require('./token-store');
const {
  createRuntimeIdentity,
  createSseStreamTransformer,
  processBody,
  transformErrorBody,
  transformJsonResponseBody
} = require('./transforms');
const { buildUpstreamHeaders, requestUpstream } = require('./upstream');

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function createIdentityRegistry(profiles) {
  const identities = new Map();
  return {
    get(profileId) {
      if (!identities.has(profileId)) identities.set(profileId, createRuntimeIdentity());
      return identities.get(profileId);
    }
  };
}

function createGatewayServer(config, options = {}) {
  let requestCount = 0;
  const startedAt = Date.now();
  const logger = options.logger || console;
  const tokenStore = options.tokenStore || new TokenStore({
    profiles: config.profiles,
    env: options.env || process.env,
    fetchImpl: options.fetchImpl,
    logger
  });
  const identities = options.identities || createIdentityRegistry(config.profiles);
  const requestFactory = options.requestUpstream || requestUpstream;

  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      try {
        const tokenInfo = tokenStore.getTokenSync(config.defaultProfile);
        const expiresIn = (tokenInfo.expiresAt - Date.now()) / 3600000;
        writeJson(res, 200, {
          status: expiresIn > 0 ? 'ok' : 'token_expired',
          proxy: 'sub-model-gateway',
          version: VERSION,
          requestsServed: requestCount,
          uptime: Math.floor((Date.now() - startedAt) / 1000) + 's',
          tokenExpiresInHours: isFinite(expiresIn) ? expiresIn.toFixed(1) : 'n/a',
          tokenCached: true,
          subscriptionType: tokenInfo.subscriptionType,
          activeProfile: config.defaultProfile,
          profiles: Object.keys(config.profiles),
          layers: {
            stringReplacements: config.activeProfile.replacements.length,
            toolNameRenames: config.activeProfile.toolRenames.length,
            propertyRenames: config.activeProfile.propRenames.length,
            ccToolStubs: config.activeProfile.injectCCStubs ? 5 : 0,
            systemStripEnabled: config.activeProfile.stripSystemConfig,
            descriptionStripEnabled: config.activeProfile.stripToolDescriptions
          }
        });
      } catch (e) {
        writeJson(res, 500, { status: 'error', message: e.message });
      }
      return;
    }

    requestCount++;
    const reqNum = requestCount;
    const profileSelection = selectProfile(req, config);
    if (profileSelection.error) {
      writeJson(res, profileSelection.error.status, {
        type: 'error',
        error: { message: profileSelection.error.message }
      });
      return;
    }

    const profileId = profileSelection.profileId;
    const profile = config.profiles[profileId];
    const identity = identities.get(profileId);
    const chunks = [];

    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      let body = Buffer.concat(chunks);
      let oauth;
      try {
        oauth = await tokenStore.getToken(profileId);
      } catch (e) {
        writeJson(res, 500, { type: 'error', error: { message: e.message } });
        return;
      }

      let bodyStr = body.toString('utf8');
      const originalSize = bodyStr.length;
      const modelMatch = bodyStr.match(/"model"\s*:\s*"([^"]+)"/);
      const requestModel = modelMatch ? modelMatch[1] : '';
      bodyStr = processBody(bodyStr, profile, { identity, logger });
      body = Buffer.from(bodyStr, 'utf8');

      const headers = buildUpstreamHeaders(req.headers, {
        oauth,
        bodyLength: body.length,
        requestModel,
        identity,
        profileHeader: config.routing && config.routing.header
      });

      const ts = new Date().toISOString().substring(11, 19);
      logger.log(`[${ts}] #${reqNum} [${profileId}] ${req.method} ${req.url} (${originalSize}b -> ${body.length}b)`);

      const upstream = requestFactory(config.upstream, {
        path: req.url,
        method: req.method,
        headers
      }, (upRes) => {
        const status = upRes.statusCode;
        logger.log(`[${ts}] #${reqNum} [${profileId}] > ${status}`);
        if (status === 401) {
          logger.warn(`[${ts}] #${reqNum} Got 401 from Anthropic - forcing token cache invalidation for profile "${profileId}".`);
          tokenStore.invalidate(profileId);
        }
        if (status !== 200 && status !== 201) {
          const errChunks = [];
          upRes.on('data', c => errChunks.push(c));
          upRes.on('end', () => {
            let errBody = Buffer.concat(errChunks).toString();
            if (errBody.includes('extra usage')) {
              logger.error(`[${ts}] #${reqNum} DETECTION! Body: ${body.length}b`);
            }
            errBody = transformErrorBody(errBody, profile);
            const nh = { ...upRes.headers };
            delete nh['transfer-encoding'];
            nh['content-length'] = Buffer.byteLength(errBody);
            res.writeHead(status, nh);
            res.end(errBody);
          });
          return;
        }

        const contentType = upRes.headers['content-type'] || '';
        if (contentType.includes('text/event-stream')) {
          const sseHeaders = { ...upRes.headers };
          delete sseHeaders['content-length'];
          delete sseHeaders['transfer-encoding'];
          res.writeHead(status, sseHeaders);
          const streamTransformer = createSseStreamTransformer(profile);
          upRes.on('data', (chunk) => {
            const output = streamTransformer.push(chunk);
            if (output) res.write(output);
          });
          upRes.on('end', () => {
            const output = streamTransformer.end();
            if (output) res.write(output);
            res.end();
          });
        } else {
          const respChunks = [];
          upRes.on('data', c => respChunks.push(c));
          upRes.on('end', () => {
            const respBody = transformJsonResponseBody(Buffer.concat(respChunks).toString(), profile);
            const nh = { ...upRes.headers };
            delete nh['transfer-encoding'];
            nh['content-length'] = Buffer.byteLength(respBody);
            res.writeHead(status, nh);
            res.end(respBody);
          });
        }
      });

      upstream.on('error', e => {
        logger.error(`[${ts}] #${reqNum} ERR: ${e.message}`);
        if (!res.headersSent) {
          writeJson(res, 502, { type: 'error', error: { message: e.message } });
        }
      });
      upstream.write(body);
      upstream.end();
    });
  });

  return server;
}

function startServer(config, options = {}) {
  const logger = options.logger || console;
  const server = createGatewayServer(config, options);
  server.listen(config.port, config.bindHost, () => {
    try {
      const tokenStore = options.tokenStore || new TokenStore({
        profiles: config.profiles,
        env: options.env || process.env,
        fetchImpl: options.fetchImpl,
        logger
      });
      const oauth = tokenStore.getTokenSync(config.defaultProfile);
      const expiresIn = (oauth.expiresAt - Date.now()) / 3600000;
      const h = isFinite(expiresIn) ? expiresIn.toFixed(1) + 'h' : 'n/a (env var)';
      const profile = config.activeProfile;
      logger.log(`\n  Sub Model Gateway v${VERSION}`);
      logger.log('  -----------------------------');
      logger.log(`  Port:              ${config.port}`);
      logger.log(`  Bind address:      ${config.bindHost}`);
      logger.log(`  Emulating:         Claude Code v${CC_VERSION}`);
      logger.log(`  Profile:           ${config.defaultProfile}`);
      logger.log(`  Subscription:      ${oauth.subscriptionType}`);
      logger.log(`  Token expires:     ${h}`);
      logger.log(`  String patterns:   ${profile.replacements.length} sanitize + ${profile.reverseMap.length} reverse`);
      logger.log(`  Tool renames:      ${profile.toolRenames.length} (bidirectional)`);
      logger.log(`  Property renames:  ${profile.propRenames.length} (bidirectional)`);
      logger.log(`  CC tool stubs:     ${profile.injectCCStubs ? 5 : 'disabled'}`);
      logger.log(`  System strip:      ${profile.stripSystemConfig ? 'enabled' : 'disabled'}`);
      logger.log(`  Description strip: ${profile.stripToolDescriptions ? 'enabled' : 'disabled'}`);
      logger.log('  Billing hash:      dynamic (SHA256 fingerprint)');
      logger.log('  CC headers:        Stainless SDK + identity');
      logger.log(`  Credentials:       ${profile.credentialsPath || profile.tokenEnv || 'none'}`);
      logger.log(`\n  Ready. Set your client baseUrl to http://${config.bindHost}:${config.port}\n`);
    } catch (e) {
      logger.error(`  Started on port ${config.port} but credentials error: ${e.message}`);
    }
  });
  return server;
}

module.exports = {
  writeJson,
  createIdentityRegistry,
  createGatewayServer,
  startServer
};
