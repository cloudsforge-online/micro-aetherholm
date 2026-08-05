// env.ts validation — a missing required variable and a placeholder secret both refuse to boot,
// naming themselves. No database needed.
//
// A valid environment is applied to the process BEFORE `./env.ts` is imported: env.ts validates
// eagerly and calls process.exit(1) on a bad configuration, so the dynamic import below is itself
// a test that these values suffice. loadEnv is otherwise pure over its source.

import assert from 'node:assert/strict';
import test from 'node:test';

const BASE: Record<string, string> = {
  AETHERHOLM_DATABASE_URL: 'postgres://aetherholm:aetherholm@127.0.0.1:5432/aetherholm',
  IDENTITY_JWKS_URL: 'http://id/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://id',
  OUTBOX_SIGNING_SECRET: 'a-real-secret-of-sufficient-length-000',
};
for (const [key, value] of Object.entries(BASE)) process.env[key] = value;

const { EnvError, loadEnv } = await import('./env.ts');

test('env: a valid environment loads, and the port defaults to 4120', () => {
  const env = loadEnv(BASE, 'host-1');
  // 4120 is the port the registry row and .env.example both state; this is the coded default the
  // estate CI compares .env.example against.
  assert.equal(env.port, 4120);
  assert.equal(env.databaseUrl, BASE['AETHERHOLM_DATABASE_URL']);
  assert.equal(env.instanceId, 'host-1');
});

test('env: a missing required variable names itself', () => {
  const missing = { ...BASE } as Record<string, string | undefined>;
  delete missing['AETHERHOLM_DATABASE_URL'];
  assert.throws(
    () => loadEnv(missing),
    (err) => err instanceof EnvError && /AETHERHOLM_DATABASE_URL/.test(err.message),
  );
});

test('env: a CHANGE_ME placeholder secret is refused', () => {
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'CHANGE_ME' }),
    (err) => err instanceof EnvError && /placeholder/.test(err.message),
  );
});

test('env: a short secret is refused (entropy proxy)', () => {
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'short' }), EnvError);
});

test('env: the event accept list defaults to the signing secret, and takes a rotation pair', () => {
  // Unset means "accept what we sign with", so shipping the inbound webhook is a no-op for a
  // deploy that has never rotated — which is what makes rotating it later service-by-service.
  assert.deepEqual(loadEnv(BASE).acceptSecrets, [BASE['OUTBOX_SIGNING_SECRET']]);

  const rotating = loadEnv({
    ...BASE,
    OUTBOX_ACCEPT_SECRETS: `the-new-secret-of-sufficient-length, ${BASE['OUTBOX_SIGNING_SECRET']}`,
  });
  assert.deepEqual(rotating.acceptSecrets, [
    'the-new-secret-of-sufficient-length',
    BASE['OUTBOX_SIGNING_SECRET'],
  ]);
});

test('env: one weak secret in the accept list is still a weak secret', () => {
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${BASE['OUTBOX_SIGNING_SECRET']},changeme` }),
    (err) => err instanceof EnvError && /placeholder/.test(err.message),
  );
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${BASE['OUTBOX_SIGNING_SECRET']},short` }),
    EnvError,
  );
});

test('env: a nonsense port is refused rather than truncated', () => {
  assert.throws(() => loadEnv({ ...BASE, PORT: '99999999' }), EnvError);
  assert.throws(() => loadEnv({ ...BASE, PORT: 'not-a-port' }), EnvError);
});

test('env: an unknown log level is refused', () => {
  assert.throws(() => loadEnv({ ...BASE, LOG_LEVEL: 'loud' }), EnvError);
});
