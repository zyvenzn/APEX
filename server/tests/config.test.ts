import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const valid = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://apex:secret@localhost:5432/apex',
  EXPECTED_DATABASE_NAME: 'apex',
  EXPECTED_DATABASE_USER: 'apex',
  APP_ORIGIN: 'http://localhost:3000'
};

test('loads validated server configuration including expected database identity', () => {
  const config = loadConfig(valid);
  assert.equal(config.PORT, 3001);
  assert.equal(config.COOKIE_SECURE, false);
  assert.equal(config.EXPECTED_DATABASE_NAME, 'apex');
  assert.equal(config.EXPECTED_DATABASE_USER, 'apex');
});

test('rejects missing database configuration and expected identity', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'test' }), /Invalid server configuration/);
  assert.throws(() => loadConfig({ ...valid, EXPECTED_DATABASE_NAME: '' }), /Invalid server configuration/);
  assert.throws(() => loadConfig({ ...valid, EXPECTED_DATABASE_USER: '' }), /Invalid server configuration/);
});

test('requires secure cookies in production', () => {
  assert.throws(() => loadConfig({ ...valid, NODE_ENV: 'production' }), /COOKIE_SECURE must be true/);
});
