'use strict';

function readClientToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return req.headers['x-api-key'] || req.headers['X-Api-Key'] || null;
}

function selectProfile(req, config) {
  const routing = config.routing || { type: 'profile' };

  if (routing.type === 'clientToken') {
    const token = readClientToken(req);
    if (!token) {
      return { error: { status: 401, message: 'Missing local client token.' } };
    }
    const profileId = routing.tokens && routing.tokens[token];
    if (!profileId || !config.profiles[profileId]) {
      return { error: { status: 403, message: 'Unknown local client token.' } };
    }
    return { profileId };
  }

  if (routing.type === 'header') {
    const header = (routing.header || 'x-sub-model-profile').toLowerCase();
    const profileId = req.headers[header] || config.defaultProfile;
    if (!profileId || !config.profiles[profileId]) {
      return { error: { status: 403, message: 'Unknown profile "' + profileId + '".' } };
    }
    return { profileId };
  }

  const profileId = routing.profile || config.defaultProfile;
  if (!profileId || !config.profiles[profileId]) {
    return { error: { status: 500, message: 'No usable profile configured.' } };
  }
  return { profileId };
}

module.exports = {
  readClientToken,
  selectProfile
};
