import crypto from 'crypto';

export function canonicalJson(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function definitionHash(definition: any): string {
  return crypto.createHash('sha256').update(canonicalJson({ nodes: definition?.nodes || [], edges: definition?.edges || [], schemaVersion: 2 })).digest('hex');
}
