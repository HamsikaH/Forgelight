#!/usr/bin/env node
// Registers the model providers from config/models.json (or config/models.example.json) with
// TrueForge, then lists the models TrueForge knows. Usage: node scripts/setup-models.mjs
// TrueForge URL: $TRUEFORGE_URL or http://localhost:8790. Secrets are never printed.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = (process.env.TRUEFORGE_URL || 'http://localhost:8790').replace(/\/+$/, '');
const PLACEHOLDER_KEY = /^\s*$|REPLACE|YOUR[_ -]|<.*>|^x{3,}$|placeholder|changeme/i;

async function loadConfig() {
  for (const name of ['models.json', 'models.example.json']) {
    const file = path.join(root, 'config', name);
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    try {
      return { file, config: JSON.parse(text) };
    } catch (err) {
      throw new Error(`${path.relative(root, file)} is not valid JSON: ${err.message}`);
    }
  }
  throw new Error('No config/models.json or config/models.example.json found.');
}

/** Collect every secret-looking string so error messages can be scrubbed. */
function secretsOf(provider) {
  const out = [];
  const walk = (v, key = '') => {
    if (typeof v === 'string' && /key|token|secret|password/i.test(key) && v.length >= 6) out.push(v);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(provider);
  return out;
}

function placeholderReason(provider) {
  const key = provider?.auth?.api_key;
  if (key === undefined) return undefined; // e.g. a keyless local provider
  return typeof key !== 'string' || PLACEHOLDER_KEY.test(key) ? 'its api key is a placeholder' : undefined;
}

async function api(method, route, body) {
  let res;
  try {
    res = await fetch(`${base}/api/v1${route}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new Error(`Cannot reach TrueForge at ${base} (${err.cause?.code ?? err.message}). Start it with scripts/start-trueforge.sh`);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) throw new Error(`${res.status} ${json?.error?.message ?? text.slice(0, 300)}`);
  return json;
}

async function main() {
  const { file, config } = await loadConfig();
  const providers = Array.isArray(config.providers) ? config.providers : [];
  console.log(`TrueForge: ${base}`);
  await api('GET', '/models'); // fail fast when TrueForge is not running
  console.log(`Providers from ${path.relative(root, file)}: ${providers.length}`);

  let failed = 0;
  for (const provider of providers) {
    const label = `${provider?.name ?? provider?.type ?? '(unnamed)'} [${provider?.type ?? '?'}]`;
    const skip = placeholderReason(provider);
    if (skip) {
      console.log(`  skip  ${label}: ${skip} (put a real key in config/models.json)`);
      continue;
    }
    try {
      // PUT = create or replace by name (POST would fail with 409 when it already exists).
      await api('PUT', '/settings/model-providers', { manifest: provider });
      // Well-known provider types are named after their type.
      const providerName = provider.name ?? provider.type;
      const models = (provider.models ?? []).map((m) => `${providerName}/${m.name}`).join(', ');
      console.log(`  ok    ${label}${models ? `: ${models}` : ''}`);
    } catch (err) {
      failed++;
      let message = err.message;
      for (const secret of secretsOf(provider)) message = message.split(secret).join('***');
      console.log(`  FAIL  ${label}: ${message}`);
    }
  }

  const list = await api('GET', '/models');
  const names = (list?.data ?? []).map((m) => m.name).filter(Boolean);
  console.log(`\nModels available in TrueForge (${names.length}):`);
  for (const name of names) console.log(`  ${name}`);
  console.log('\nPut the ones you want, in priority order, in the VS Code setting forgelight.models.');
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`setup-models: ${err.message}`);
  process.exitCode = 1;
});
