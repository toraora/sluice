import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { Route, RouteTable } from './types.js';

type ServerlessEvent = {
  httpApi?: { method: string; path: string } | string;
  http?: { method: string; path: string } | string;
  schedule?: string;
};

type ServerlessFunction = {
  handler: string;
  events?: ServerlessEvent[];
  environment?: Record<string, string>;
};

type ServerlessConfig = {
  service: string;
  functions?: Record<string, ServerlessFunction>;
  provider?: {
    environment?: Record<string, string>;
  };
  custom?: {
    'serverless-offline'?: { prefix?: string };
    customDomain?: {
      http?: { basePath?: string };
      rest?: { basePath?: string };
    };
  };
};

function parseHandlerRef(handler: string): { module: string; exportName: string } {
  const lastDot = handler.lastIndexOf('.');
  if (lastDot === -1) {
    return { module: `./${handler}`, exportName: 'handler' };
  }
  return {
    module: `./${handler.substring(0, lastDot)}`,
    exportName: handler.substring(lastDot + 1),
  };
}

function extractHttpEvent(event: ServerlessEvent): { method: string; path: string } | null {
  const httpApi = event.httpApi;
  if (httpApi) {
    if (typeof httpApi === 'string') return null;
    return { method: httpApi.method.toUpperCase(), path: httpApi.path };
  }

  const http = event.http;
  if (http) {
    if (typeof http === 'string') return null;
    return { method: http.method.toUpperCase(), path: http.path };
  }

  return null;
}

function cleanEnvValues(env: unknown): Record<string, string> {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (value === 'SLUICE_PLACEHOLDER' || value === null || value === undefined) continue;
    result[key] = String(value);
  }
  return result;
}

export function parseServerlessYml(filePath: string): RouteTable {
  const raw = readFileSync(filePath, 'utf8');

  // Strip Serverless Framework variable syntax like ${file(...):...}, ${self:...}, ${ssm:...}
  // so the YAML parser doesn't choke. We only need function definitions and paths.
  const sanitized = raw.replace(/\$\{[^}]+\}/g, 'SLUICE_PLACEHOLDER');

  const config = parse(sanitized) as ServerlessConfig;
  const service = config.service ?? 'unknown';
  const providerEnvironment = cleanEnvValues(config.provider?.environment);

  // Extract prefix from serverless-offline config or customDomain basePath.
  // The value may contain SLUICE_PLACEHOLDER from stripped ${self:service} refs —
  // replace with the actual service name.
  let prefix = config.custom?.['serverless-offline']?.prefix
    ?? config.custom?.customDomain?.http?.basePath
    ?? config.custom?.customDomain?.rest?.basePath;
  if (prefix) {
    prefix = prefix.replace(/SLUICE_PLACEHOLDER/g, service);
  }

  const routes: Route[] = [];

  for (const [functionName, fn] of Object.entries(config.functions ?? {})) {
    if (!fn.events) continue;

    const { module, exportName } = parseHandlerRef(fn.handler);
    const fnEnv = cleanEnvValues(fn.environment);

    for (const event of fn.events) {
      const httpEvent = extractHttpEvent(event);
      if (!httpEvent) continue;

      routes.push({
        functionName,
        method: httpEvent.method,
        path: httpEvent.path,
        handler: fn.handler,
        module,
        exportName,
        environment: Object.keys(fnEnv).length > 0 ? fnEnv : undefined,
      });
    }
  }

  return { service, routes, providerEnvironment, prefix };
}
