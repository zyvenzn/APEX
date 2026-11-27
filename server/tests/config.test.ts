import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const valid = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://apex:secret@localhost:5432/apex',
  REDIS_URL: 'redis://localhost:6379',
  APP_ORIGIN: 'http://localhost:3000'
};

test('loads validated server configuration', () => {
  const config = loadConfig(valid);
  assert.equal(config.PORT, 3001);
  assert.equal(config.COOKIE_SECURE, false);
});

test('rejects missing database and redis configuration', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'test' }), /Invalid server configuration/);
});

test('requires secure cookies in production', () => {
  assert.throws(() => loadConfig({ ...valid, NODE_ENV: 'production' }), /COOKIE_SECURE must be true/);
});