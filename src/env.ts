/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable this service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out has
 * nothing to justify it.
 *
 * Two behaviours are deliberate estate house style:
 *   1. A missing variable names itself (rather than surfacing as an unreadable driver error later).
 *   2. A known placeholder is refused outright — a default secret that boots is a default secret
 *      that reaches production.
 *
 * There is deliberately no upstream URL and no service token here. Phase 1 of this title makes no
 * outbound HTTP call: the title contract is INBOUND (worlds calls `POST /v1/provision` with its own
 * scoped credential), entitlement consumption arrives on that call, and every background timer is a
 * leased job against this service's own database. A variable nothing reads is a secret nothing
 * needed handed to a container anyway.
 */

import { hostname } from 'node:os';

/** This service's own name. A constant — a property of the repository, not the deployment. */
export const SERVICE = 'aetherholm';

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

const PLACEHOLDERS = new Set([
  'changeme',
  'change_me',
  'change-me',
  'placeholder',
  'secret',
  'token',
  'dev-secret',
  'replace-with-a-real-secret',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
]);

type Source = Readonly<Record<string, string | undefined>>;

function required(source: Source, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`);
  return value;
}

function requiredSecret(source: Source, name: string, minLength = 24): string {
  const value = required(source, name);
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new EnvError(`${name} is set to a known placeholder — generate a real secret`);
  }
  if (value.length < minLength) {
    throw new EnvError(`${name} must be at least ${minLength} characters (got ${value.length})`);
  }
  return value;
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

/**
 * A comma-separated secret list, newest first, with the placeholder rule applied to every entry.
 *
 * One weak secret in an accept list is a weak secret, so the check that guards a single value
 * guards every value here too — an accept list is exactly where a "just for the rotation" filler
 * would otherwise get in.
 */
function secretList(source: Source, name: string, fallback: string): readonly string[] {
  const raw = optional(source, name, fallback);
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) throw new EnvError(`${name} is set but lists no secrets`);
  for (const value of values) {
    if (PLACEHOLDERS.has(value.toLowerCase())) {
      throw new EnvError(`${name} lists a known placeholder — generate a real secret`);
    }
    if (value.length < 24) {
      throw new EnvError(`${name} lists a secret shorter than 24 characters`);
    }
  }
  return Object.freeze(values);
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`);
  }
  return value;
}

export interface Env {
  readonly port: number;
  readonly env: string;
  readonly version: string;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Rule 1: one database, named by this service's own variable. */
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly identityJwksUrl: string;
  readonly identityIssuer: string;
  /** HMAC key for outbound event signatures. */
  readonly outboxSigningSecret: string;
  /**
   * The secrets `POST /v1/events` will ACCEPT, newest first.
   *
   * Defaults to `[outboxSigningSecret]` when `OUTBOX_ACCEPT_SECRETS` is unset, so a deploy that
   * never sets it behaves exactly as one that cannot rotate. That default is what lets the shared
   * signing secret be rotated one service at a time instead of on a flag day.
   */
  readonly acceptSecrets: readonly string[];
  readonly instanceId: string;
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info');
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`);
  }
  const outboxSigningSecret = requiredSecret(source, 'OUTBOX_SIGNING_SECRET');

  return {
    // 4120, and `.env.example` must agree — CI compares the two, because two repos in this estate
    // shipped the disagreement and put three services on one port.
    port: integer(source, 'PORT', 4120, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'AETHERHOLM_DATABASE_URL'),
    databasePoolMax: integer(source, 'AETHERHOLM_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret,
    acceptSecrets: secretList(source, 'OUTBOX_ACCEPT_SECRETS', outboxSigningSecret),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),
  };
}

function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  );
  process.exit(1);
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname());
  } catch (err) {
    fatalConfig(err);
  }
})();
