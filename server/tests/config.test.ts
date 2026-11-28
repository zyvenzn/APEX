import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const valid = {
  NODE_ENV: 'test',
  DEPLOYMENT_ENVIRONMENT: 'test',
  DATABASE_URL: 'postgres://apex:secret@localhost:5432/apex',
  EXPECTED_DATABASE_NAME: 'apex',
  EXPECTED_DATABASE_USER: 'apex',
  EXPECTED_DATABASE_INSTANCE_ID: '00000000-0000-4000-8000-000000000002',
  APP_ORIGIN: 'http://localhost:3000'
};

test('loads deployment and independently provisioned database identity configuration', () => {
  const loaded = loadConfig(valid);
  assert.equal(loaded.PORT, 3001);
  assert.equal(loaded.COOKIE_SECURE, false);
  assert.equal(loaded.DEPLOYMENT_ENVIRONMENT, 'test');
  assert.equal(loaded.EXPECTED_DATABASE_INSTANCE_ID, valid.EXPECTED_DATABASE_INSTANCE_ID);
});

test('rejects missing or malformed independent database identity configuration', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'test' }), /Invalid server configuration/);
  assert.throws(() => loadConfig({ ...valid, EXPECTED_DATABASE_NAME: '' }), /Invalid server configuration/);
  assert.throws(() => loadConfig({ ...valid, EXPECTED_DATABASE_USER: '' }), /Invalid server configuration/);
  assert.throws(() => loadConfig({ ...valid, EXPECTED_DATABASE_INSTANCE_ID: 'not-a-uuid' }), /Invalid server configuration/);
});

test('production requires secure cookies and an explicit staging or production environment', () => {
  assert.throws(() => loadConfig({ ...valid, NODE_ENV: 'production', DEPLOYMENT_ENVIRONMENT: 'development' }), /COOKIE_SECURE must be true/);
  assert.throws(() => loadConfig({
    ...valid, NODE_ENV: 'production', COOKIE_SECURE: 'true', DEPLOYMENT_ENVIRONMENT: 'test'
  }), /DEPLOYMENT_ENVIRONMENT must be staging or production/);
  assert.equal(loadConfig({
    ...valid, NODE_ENV: 'production', COOKIE_SECURE: 'true', DEPLOYMENT_ENVIRONMENT: 'staging'
  }).COOKIE_SECURE, true);
});
