/**
 * A deliberately small JSON-Logic compatible evaluator. It never evaluates source code.
 * Expressions must be JSON values such as {"and":[{">":[{"var":"payload.total"},100]},true]}.
 */
export type SafeExpression = null | boolean | number | string | SafeExpression[] | { [operator: string]: SafeExpression };

const MAX_DEPTH = 40;
const MAX_ARRAY_ITEMS = 1_000;

function getPath(source: any, path: string, fallback?: any) {
  if (!path) return source;
  const safeParts = path.split('.').filter(Boolean);
  let current = source;
  for (const part of safeParts) {
    if (['__proto__', 'prototype', 'constructor'].includes(part)) return fallback;
    if (current === null || current === undefined || typeof current !== 'object' || !(part in current)) return fallback;
    current = current[part];
  }
  return current;
}

function values(arg: any): any[] { return Array.isArray(arg) ? arg : [arg]; }
function number(value: any) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error('Expression requires a finite number');
  return parsed;
}

export function evaluateExpression(expression: any, data: any, depth = 0): any {
  if (depth > MAX_DEPTH) throw new Error('Expression exceeds maximum depth');
  if (expression === null || expression === undefined || typeof expression !== 'object') return expression;
  if (Array.isArray(expression)) {
    if (expression.length > MAX_ARRAY_ITEMS) throw new Error('Expression array is too large');
    return expression.map(value => evaluateExpression(value, data, depth + 1));
  }
  const entries = Object.entries(expression);
  if (entries.length !== 1) throw new Error('Expression objects must contain exactly one operator');
  const [operator, rawArgs] = entries[0]!;
  const args = values(rawArgs);
  const evaluated = () => args.map(item => evaluateExpression(item, data, depth + 1));

  switch (operator) {
    case 'var': {
      const path = evaluateExpression(args[0] ?? '', data, depth + 1);
      const fallback = args.length > 1 ? evaluateExpression(args[1], data, depth + 1) : null;
      return getPath(data, String(path || ''), fallback);
    }
    case 'missing': {
      const paths = Array.isArray(rawArgs) ? rawArgs : [rawArgs];
      return paths.map(String).filter(path => getPath(data, path, undefined) === undefined);
    }
    case '!': return !evaluateExpression(args[0], data, depth + 1);
    case '!!': return !!evaluateExpression(args[0], data, depth + 1);
    case 'and': {
      let result: any = true;
      for (const arg of args) { result = evaluateExpression(arg, data, depth + 1); if (!result) return result; }
      return result;
    }
    case 'or': {
      let result: any = false;
      for (const arg of args) { result = evaluateExpression(arg, data, depth + 1); if (result) return result; }
      return result;
    }
    case 'if': {
      for (let index = 0; index + 1 < args.length; index += 2) {
        if (evaluateExpression(args[index], data, depth + 1)) return evaluateExpression(args[index + 1], data, depth + 1);
      }
      return args.length % 2 ? evaluateExpression(args[args.length - 1], data, depth + 1) : null;
    }
    case '===': { const v = evaluated(); return v[0] === v[1]; }
    case '==': { const v = evaluated(); return String(v[0] ?? '') === String(v[1] ?? ''); }
    case '!==': { const v = evaluated(); return v[0] !== v[1]; }
    case '!=': { const v = evaluated(); return String(v[0] ?? '') !== String(v[1] ?? ''); }
    case '>': { const v = evaluated(); return number(v[0]) > number(v[1]); }
    case '>=': { const v = evaluated(); return number(v[0]) >= number(v[1]); }
    case '<': { const v = evaluated(); return number(v[0]) < number(v[1]); }
    case '<=': { const v = evaluated(); return number(v[0]) <= number(v[1]); }
    case '+': return evaluated().reduce((sum, item) => sum + number(item), 0);
    case '-': { const v = evaluated().map(number); const first = v[0] ?? 0; return v.length === 1 ? -first : v.slice(1).reduce((n, item) => n - item, first); }
    case '*': return evaluated().reduce((product, item) => product * number(item), 1);
    case '/': { const v = evaluated().map(number); return v.slice(1).reduce((n, item) => { if (item === 0) throw new Error('Division by zero'); return n / item; }, v[0] ?? 0); }
    case '%': { const v = evaluated().map(number); const divisor = v[1] ?? 0; if (divisor === 0) throw new Error('Division by zero'); return (v[0] ?? 0) % divisor; }
    case 'min': return Math.min(...evaluated().map(number));
    case 'max': return Math.max(...evaluated().map(number));
    case 'cat': return evaluated().map(item => String(item ?? '')).join('');
    case 'lower': return String(evaluateExpression(args[0], data, depth + 1) ?? '').toLowerCase();
    case 'upper': return String(evaluateExpression(args[0], data, depth + 1) ?? '').toUpperCase();
    case 'length': {
      const item = evaluateExpression(args[0], data, depth + 1);
      return typeof item === 'string' || Array.isArray(item) ? item.length : item && typeof item === 'object' ? Object.keys(item).length : 0;
    }
    case 'in': {
      const v = evaluated();
      if (Array.isArray(v[1])) return v[1].includes(v[0]);
      return String(v[1] ?? '').includes(String(v[0] ?? ''));
    }
    default: throw new Error(`Unsupported expression operator: ${operator}`);
  }
}

export function parseSafeExpression(value: any): SafeExpression {
  if (typeof value !== 'string') return value as SafeExpression;
  if (value.length > 100_000) throw new Error('Expression is too large');
  try { return JSON.parse(value) as SafeExpression; }
  catch { throw new Error('Expression must be valid JSON, not JavaScript source'); }
}
