export function getByPath(obj: any, path: string) {
  return path.split('.').reduce((acc: any, k: string) => {
    if (['__proto__', 'prototype', 'constructor'].includes(k)) return undefined;
    return acc && typeof acc === 'object' ? acc[k] : undefined;
  }, obj);
}

function applyFilter(val: any, name: string, arg?: string) {
  switch ((name||'').trim()) {
    case 'json':
      return JSON.stringify(val);
    case 'join': {
      if (!Array.isArray(val)) return '';
      const sep = (arg ?? ',').trim();
      return val.map((x:any)=> (x==null?'':String(x))).join(sep);
    }
    default:
      return val;
  }
}

export function renderTemplate(str: string, ctx: any) {
  if (!str) return str;
  return str.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_m, p1) => {
    const body = String(p1).trim();
    // support filters: path | json   OR   path | join:","
    const parts = body.split('|').map(s=>s.trim());
    const path = parts.shift() || '';
    let v: any = getByPath(ctx, path);
    for (const f of parts) {
      const [fname, fargRaw] = f.split(':').map(s=>s.trim());
      const farg = fargRaw ? fargRaw.replace(/^["']|["']$/g,'') : undefined;
      v = applyFilter(v, fname || '', farg);
    }
    if (v === undefined || v === null) return '';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
}
