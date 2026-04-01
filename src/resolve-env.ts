import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { parse } from 'yaml';

type RawConfig = Record<string, unknown>;

function readYaml(filePath: string): RawConfig {
  return parse(readFileSync(filePath, 'utf8')) as RawConfig;
}

function navigatePath(obj: unknown, keyPath: string): unknown {
  let current = obj;
  for (const segment of keyPath.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// Resolve a single ${...} expression. Returns the resolved string value,
// or the original expression if it can't be resolved yet.
function resolveExpression(
  expr: string,
  ctx: ResolveContext,
): string | Record<string, unknown> | undefined {
  // ${sls:stage}
  if (expr === 'sls:stage') return ctx.stage;

  // ${self:service}
  if (expr.startsWith('self:')) {
    const path = expr.slice(5);
    // Handle fallback: ${self:provider.region, 'us-west-2'}
    const [mainPath, fallback] = splitFallback(path);
    const val = navigatePath(ctx.config, mainPath);
    if (val !== undefined && val !== null) return String(val);
    if (fallback !== undefined) return fallback;
    return undefined;
  }

  // ${env:VAR_NAME, 'default'} or ${env:VAR_NAME, ssm:fallback}
  if (expr.startsWith('env:')) {
    const rest = expr.slice(4);
    const [varName, fallback] = splitFallback(rest);
    const val = process.env[varName];
    if (val !== undefined) return val;
    if (fallback !== undefined) {
      // Fallback might be an ssm: reference
      if (fallback.startsWith('ssm:')) return '${' + fallback + '}';
      return fallback;
    }
    return undefined;
  }

  // ${file(path):keyPath} or ${file(path):keyPath.${sls:stage}, fallback}
  if (expr.startsWith('file(')) {
    return resolveFileRef(expr, ctx);
  }

  // ${ssm:paramName} — leave as-is for the SSM pass
  if (expr.startsWith('ssm:')) return '${' + expr + '}';

  return undefined;
}

function resolveFileRef(
  expr: string,
  ctx: ResolveContext,
): string | Record<string, unknown> | undefined {
  // Parse: file(../path.yml):key.path, fallback
  const parenClose = expr.indexOf(')');
  if (parenClose === -1) return undefined;

  const filePath = expr.slice(5, parenClose);
  const afterParen = expr.slice(parenClose + 1);

  let keyPath: string | undefined;
  let fallback: string | undefined;

  if (afterParen.startsWith(':')) {
    const rest = afterParen.slice(1);
    [keyPath, fallback] = splitFallback(rest);
  }

  const absPath = resolve(ctx.configDir, filePath);
  if (!existsSync(absPath)) {
    return fallback ?? undefined;
  }

  const fileContent = readYaml(absPath);

  if (!keyPath) return fileContent as Record<string, unknown>;

  // The key path itself may contain ${sls:stage} etc — resolve those first
  const resolvedKeyPath = resolveVariablesInString(keyPath, ctx);
  const val = navigatePath(fileContent, resolvedKeyPath);

  if (val === undefined || val === null) return fallback ?? undefined;
  if (typeof val === 'object') return val as Record<string, unknown>;
  return String(val);
}

function splitFallback(s: string): [string, string | undefined] {
  // Find top-level comma (not inside ${...})
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '$' && s[i + 1] === '{') depth++;
    else if (s[i] === '}') depth--;
    else if (s[i] === ',' && depth === 0) {
      const main = s.substring(0, i).trim();
      let fallback = s.substring(i + 1).trim();
      // Strip surrounding quotes from fallback
      if ((fallback.startsWith("'") && fallback.endsWith("'")) ||
          (fallback.startsWith('"') && fallback.endsWith('"'))) {
        fallback = fallback.slice(1, -1);
      }
      return [main, fallback];
    }
  }
  return [s, undefined];
}

type ResolveContext = {
  stage: string;
  config: RawConfig;
  configDir: string;
};

// Resolve all ${...} expressions in a string, handling nesting.
// Returns resolved string, or an object if the entire value is a single
// ${file(...)} that resolves to an object.
function resolveVariablesInString(input: string, ctx: ResolveContext): string {
  // Iteratively resolve from the inside out
  let result = input;
  let maxIter = 10;
  while (maxIter-- > 0 && result.includes('${')) {
    const next = result.replace(/\$\{([^{}]+)\}/g, (_match, expr: string) => {
      const resolved = resolveExpression(expr, ctx);
      if (resolved === undefined) return _match;
      if (typeof resolved === 'object') return JSON.stringify(resolved);
      return resolved;
    });
    if (next === result) break;
    result = next;
  }
  return result;
}

function resolveVariablesInValue(
  value: unknown,
  ctx: ResolveContext,
): unknown {
  if (typeof value === 'string') {
    let working = value;
    let maxIter = 10;
    while (maxIter-- > 0 && working.includes('${')) {
      // If the entire string is a single ${...} (no nested braces), try object resolution
      const singleMatch = working.match(/^\$\{([^{}]+)\}$/);
      if (singleMatch) {
        const resolved = resolveExpression(singleMatch[1], ctx);
        if (resolved !== undefined && typeof resolved === 'object') return resolved;
        if (typeof resolved === 'string') { working = resolved; continue; }
        break;
      }

      // Resolve innermost ${...} expressions as strings
      const next = working.replace(/\$\{([^{}]+)\}/g, (_match, expr: string) => {
        const resolved = resolveExpression(expr, ctx);
        if (resolved === undefined) return _match;
        if (typeof resolved === 'object') return JSON.stringify(resolved);
        return resolved;
      });
      if (next === working) break;
      working = next;
    }
    return working;
  }
  if (Array.isArray(value)) return value.map((v) => resolveVariablesInValue(v, ctx));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = resolveVariablesInValue(v, ctx);
    }
    return result;
  }
  return value;
}

// Collect all ${ssm:paramName} references from resolved env values
function collectSsmParams(env: Record<string, string>): string[] {
  const params = new Set<string>();
  const re = /\$\{ssm:([^}]+)\}/g;
  for (const value of Object.values(env)) {
    let match;
    while ((match = re.exec(value)) !== null) {
      params.add(match[1]);
    }
  }
  return [...params];
}

function batchFetchSsmParams(
  paramNames: string[],
  region?: string,
): Record<string, string> {
  if (paramNames.length === 0) return {};

  const result: Record<string, string> = {};
  // AWS SSM GetParameters supports up to 10 params per call
  const batchSize = 10;

  for (let i = 0; i < paramNames.length; i += batchSize) {
    const batch = paramNames.slice(i, i + batchSize);
    const names = batch.map((n) => `"${n}"`).join(' ');
    const regionFlag = region ? `--region ${region}` : '';

    try {
      const cmd = `aws ssm get-parameters --names ${names} ${regionFlag} --output json 2>&1`;
      const stdout = execSync(cmd, { encoding: 'utf8', timeout: 30000 });
      const response = JSON.parse(stdout) as {
        Parameters: Array<{ Name: string; Value: string }>;
        InvalidParameters?: string[];
      };

      for (const param of response.Parameters) {
        result[param.Name] = param.Value;
      }

      if (response.InvalidParameters?.length) {
        console.warn(`SSM params not found: ${response.InvalidParameters.join(', ')}`);
      }
    } catch (err) {
      console.error(`Failed to fetch SSM batch: ${batch.join(', ')}`);
      console.error(String(err));
    }
  }

  return result;
}

function applySsmValues(
  env: Record<string, string>,
  ssmValues: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    result[key] = value.replace(/\$\{ssm:([^}]+)\}/g, (_match, paramName: string) => {
      return ssmValues[paramName] ?? _match;
    });
  }
  return result;
}

export async function resolveEnvironment(opts: {
  serverlessFile: string;
  stage: string;
  region?: string;
  skipSsm?: boolean;
}): Promise<Record<string, string>> {
  const absPath = resolve(opts.serverlessFile);
  const configDir = dirname(absPath);
  const config = readYaml(absPath);

  const ctx: ResolveContext = {
    stage: opts.stage,
    config,
    configDir,
  };

  // Resolve provider.environment (may be a ${file(...)} ref that returns an object)
  const rawProviderEnv = navigatePath(config, 'provider.environment');
  let resolvedProviderEnv = resolveVariablesInValue(rawProviderEnv, ctx);
  // The returned object's values may still contain ${...} refs — resolve those
  if (resolvedProviderEnv && typeof resolvedProviderEnv === 'object' && !Array.isArray(resolvedProviderEnv)) {
    resolvedProviderEnv = resolveVariablesInValue(resolvedProviderEnv, ctx);
  }

  // Collect all functions' per-function environment overrides
  const functions = (config.functions ?? {}) as Record<string, { environment?: unknown }>;
  const perFunctionEnv: Record<string, Record<string, string>> = {};
  for (const [fnName, fn] of Object.entries(functions)) {
    if (!fn.environment) continue;
    const resolved = resolveVariablesInValue(fn.environment, ctx);
    if (resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(resolved)) {
        if (v !== null && v !== undefined) flat[k] = String(v);
      }
      if (Object.keys(flat).length > 0) perFunctionEnv[fnName] = flat;
    }
  }

  // Flatten provider env into a string map
  const envMap: Record<string, string> = {};
  if (resolvedProviderEnv && typeof resolvedProviderEnv === 'object' && !Array.isArray(resolvedProviderEnv)) {
    for (const [k, v] of Object.entries(resolvedProviderEnv as Record<string, unknown>)) {
      if (v !== null && v !== undefined) envMap[k] = String(v);
    }
  }

  // Merge per-function env (all unique keys)
  for (const fnEnv of Object.values(perFunctionEnv)) {
    for (const [k, v] of Object.entries(fnEnv)) {
      if (!(k in envMap)) envMap[k] = v;
    }
  }

  if (opts.skipSsm) return envMap;

  // Resolve SSM parameters
  const ssmParams = collectSsmParams(envMap);
  if (ssmParams.length === 0) return envMap;

  console.log(`Fetching ${ssmParams.length} SSM parameters...`);
  const ssmValues = batchFetchSsmParams(ssmParams, opts.region);
  console.log(`Resolved ${Object.keys(ssmValues).length}/${ssmParams.length} SSM parameters`);

  return applySsmValues(envMap, ssmValues);
}

export function writeEnvFile(env: Record<string, string>, outputPath: string) {
  const lines: string[] = [
    '# Generated by sluice resolve-env',
    `# ${new Date().toISOString()}`,
    '',
  ];

  const unresolved: string[] = [];

  for (const [key, value] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
    if (value.includes('${')) {
      unresolved.push(key);
      lines.push(`# UNRESOLVED: ${key}=${value}`);
    } else {
      // Quote values that contain spaces or special characters
      const needsQuotes = /[\s#"'$]/.test(value);
      lines.push(needsQuotes ? `${key}="${value}"` : `${key}=${value}`);
    }
  }

  lines.push('');
  writeFileSync(outputPath, lines.join('\n'), 'utf8');

  if (unresolved.length > 0) {
    console.warn(`${unresolved.length} variables could not be fully resolved (commented out in .env)`);
  }
}
