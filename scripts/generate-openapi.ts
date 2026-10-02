import { readFileSync, writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config.js';
import { buildOpenApiSpec } from '../src/openapi.js';

export const SPEC_FILE = new URL('../openapi.yaml', import.meta.url);
export const HEADER = '# Generated from the zod schemas by `npm run openapi`. Do not edit by hand.\n';

export function renderSpec(): string {
  return HEADER + stringify(buildOpenApiSpec(loadConfig({})), { lineWidth: 0 });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)) {
  const check = process.argv.includes('--check');
  const rendered = renderSpec();
  if (check) {
    if (readFileSync(SPEC_FILE, 'utf8') !== rendered) {
      console.error('openapi.yaml is out of date. Run `npm run openapi` and commit the result.');
      process.exit(1);
    }
    console.log('openapi.yaml is up to date.');
  } else {
    writeFileSync(SPEC_FILE, rendered);
    console.log('Wrote openapi.yaml');
  }
}
