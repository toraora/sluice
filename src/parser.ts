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
};

type ServerlessConfig = {
  service: string;
  functions?: Record<string, ServerlessFunction>;
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
    if (typeof httpApi === 'string') return null; // e.g. httpApi: '*'
    return { method: httpApi.method.toUpperCase(), path: httpApi.path };
  }

  const http = event.http;
  if (http) {
    if (typeof http === 'string') return null;
    return { method: http.method.toUpperCase(), path: http.path };
  }

  return null;
}

export function parseServerlessYml(filePath: string): RouteTable {
  const raw = readFileSync(filePath, 'utf8');

  // Strip Serverless Framework variable syntax like ${file(...):...}, ${self:...}, ${ssm:...}
  // so the YAML parser doesn't choke. We only need function definitions and paths.
  const sanitized = raw.replace(/\$\{[^}]+\}/g, 'SLUICE_PLACEHOLDER');

  const config = parse(sanitized) as ServerlessConfig;
  const routes: Route[] = [];

  for (const [functionName, fn] of Object.entries(config.functions ?? {})) {
    if (!fn.events) continue;

    const { module, exportName } = parseHandlerRef(fn.handler);

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
      });
    }
  }

  return { service: config.service ?? 'unknown', routes };
}
