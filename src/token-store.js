'use strict';

const fs = require('fs');
const { OAUTH_CLIENT_ID, OAUTH_TOKEN_URL } = require('./constants');

function stripBom(raw) {
  return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
}

function readCredentialsFile(credentialsPath) {
  const raw = stripBom(fs.readFileSync(credentialsPath, 'utf8'));
  const creds = JSON.parse(raw);
  const oauth = creds.claudeAiOauth;
  if (!oauth || !oauth.accessToken) throw new Error('No OAuth token. Run "claude auth login".');
  return { creds, oauth };
}

class TokenStore {
  constructor(options) {
    this.profiles = options.profiles || {};
    this.env = options.env || process.env;
    this.fetchImpl = options.fetchImpl || fetch;
    this.logger = options.logger || console;
    this.oauthTokenUrl = options.oauthTokenUrl || OAUTH_TOKEN_URL;
    this.oauthClientId = options.oauthClientId || OAUTH_CLIENT_ID;
    this.states = new Map();
  }

  getProfile(profileId) {
    const profile = this.profiles[profileId];
    if (!profile) throw new Error('Unknown profile "' + profileId + '".');
    return profile;
  }

  stateFor(profileId) {
    if (!this.states.has(profileId)) {
      this.states.set(profileId, {
        cachedToken: null,
        refreshPromise: null
      });
    }
    return this.states.get(profileId);
  }

  readToken(profileId) {
    const profile = this.getProfile(profileId);
    const envName = profile.tokenEnv || (profile.credentialsPath === 'env' ? 'OAUTH_TOKEN' : null);
    if (envName) {
      const token = this.env[envName];
      if (!token) throw new Error(envName + ' env var is empty.');
      return { accessToken: token, expiresAt: Infinity, subscriptionType: 'env-var' };
    }

    if (!profile.credentialsPath) {
      throw new Error('No credentialsPath configured for profile "' + profileId + '".');
    }

    const { oauth } = readCredentialsFile(profile.credentialsPath);
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt ?? Infinity,
      subscriptionType: oauth.subscriptionType ?? 'unknown'
    };
  }

  getTokenSync(profileId) {
    const state = this.stateFor(profileId);
    if (state.cachedToken && (state.cachedToken.expiresAt - Date.now()) > 5 * 60 * 1000) {
      return state.cachedToken;
    }
    const token = this.readToken(profileId);
    state.cachedToken = token;
    return token;
  }

  async refreshOAuthToken(profileId, refreshToken) {
    const profile = this.getProfile(profileId);
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.oauthClientId,
      refresh_token: refreshToken,
    }).toString();

    const res = await this.fetchImpl(this.oauthTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      throw new Error(`Token refresh HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data.access_token) {
      throw new Error('Token refresh: no access_token in response');
    }

    const prior = this.stateFor(profileId).cachedToken;
    const newToken = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 36000) * 1000,
      subscriptionType: prior?.subscriptionType ?? 'unknown',
    };

    const envName = profile.tokenEnv || (profile.credentialsPath === 'env' ? 'OAUTH_TOKEN' : null);
    if (profile.credentialsPath && !envName) {
      try {
        const { creds } = readCredentialsFile(profile.credentialsPath);
        creds.claudeAiOauth = {
          ...creds.claudeAiOauth,
          accessToken: newToken.accessToken,
          refreshToken: newToken.refreshToken,
          expiresAt: newToken.expiresAt,
        };
        fs.writeFileSync(profile.credentialsPath, JSON.stringify(creds, null, 2), 'utf8');
        this.logger.log(`[OAUTH] Refreshed token written back to credentials file for profile "${profileId}".`);
      } catch (writeErr) {
        this.logger.warn('[OAUTH] Could not write refreshed token to file:', writeErr.message);
      }
    }

    this.logger.log(`[OAUTH] Token refreshed for profile "${profileId}". Expires in ${Math.round((data.expires_in ?? 36000) / 3600)}h.`);
    return newToken;
  }

  async getToken(profileId) {
    const state = this.stateFor(profileId);
    const profile = this.getProfile(profileId);
    const envName = profile.tokenEnv || (profile.credentialsPath === 'env' ? 'OAUTH_TOKEN' : null);
    if (envName) {
      return this.getTokenSync(profileId);
    }

    if (state.cachedToken && (state.cachedToken.expiresAt - Date.now()) > 5 * 60 * 1000) {
      return state.cachedToken;
    }

    state.cachedToken = this.readToken(profileId);
    const timeRemaining = state.cachedToken.expiresAt - Date.now();
    if (timeRemaining < 5 * 60 * 1000 && state.cachedToken.refreshToken) {
      if (!state.refreshPromise) {
        this.logger.log(`[OAUTH] Token expiring soon for profile "${profileId}", refreshing...`);
        state.refreshPromise = this.refreshOAuthToken(profileId, state.cachedToken.refreshToken)
          .finally(() => { state.refreshPromise = null; });
      }
      try {
        state.cachedToken = await state.refreshPromise;
      } catch (refreshErr) {
        this.logger.warn('[OAUTH] Refresh failed, using existing token:', refreshErr.message);
      }
    }

    return state.cachedToken;
  }

  invalidate(profileId) {
    const state = this.stateFor(profileId);
    state.cachedToken = null;
  }
}

module.exports = {
  TokenStore,
  stripBom,
  readCredentialsFile
};
