'use strict';

const http = require('http');
const https = require('https');
const { UPSTREAM_HOST } = require('./constants');
const { getModelBetas, getStainlessHeaders } = require('./transforms');

function buildUpstreamHeaders(reqHeaders, options) {
  const headers = {};
  const profileHeader = (options.profileHeader || 'x-sub-model-profile').toLowerCase();

  for (const [key, value] of Object.entries(reqHeaders)) {
    const lk = key.toLowerCase();
    if (lk === 'host' || lk === 'connection' || lk === 'authorization' ||
        lk === 'x-api-key' || lk === 'content-length' ||
        lk === 'x-session-affinity' || lk === profileHeader) continue;
    headers[key] = value;
  }

  headers.authorization = `Bearer ${options.oauth.accessToken}`;
  headers['content-length'] = options.bodyLength;
  headers['accept-encoding'] = 'identity';
  headers['anthropic-version'] = '2023-06-01';

  const ccHeaders = getStainlessHeaders(options.identity);
  for (const [k, v] of Object.entries(ccHeaders)) {
    headers[k] = v;
  }

  const modelBetas = getModelBetas(options.requestModel);
  const existingBeta = headers['anthropic-beta'] || '';
  const betas = existingBeta ? existingBeta.split(',').map(b => b.trim()).filter(Boolean) : [];
  for (const b of modelBetas) {
    if (!betas.includes(b)) betas.push(b);
  }
  headers['anthropic-beta'] = betas.join(',');

  return headers;
}

function requestUpstream(upstreamConfig, requestOptions, callback) {
  const upstream = upstreamConfig || {};
  const protocol = upstream.protocol || 'https:';
  const transport = protocol === 'http:' ? http : https;
  return transport.request({
    hostname: upstream.host || UPSTREAM_HOST,
    port: upstream.port || (protocol === 'http:' ? 80 : 443),
    path: requestOptions.path,
    method: requestOptions.method,
    headers: requestOptions.headers
  }, callback);
}

module.exports = {
  buildUpstreamHeaders,
  requestUpstream
};
