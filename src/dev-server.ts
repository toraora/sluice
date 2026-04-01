import { createServer } from 'node:http';
import { resolve } from 'node:path';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import type { Route, RouteTable } from './types.js';

type Handler = (event: APIGatewayProxyEventV2, context: Context) => Promise<APIGatewayProxyStructuredResultV2>;

function buildLambdaFunctionName(service: string, stage: string, functionName: string): string {
  return `${service}-${stage}-${functionName}`;
}

function buildFakeContext(functionName: string): Context {
  return {
    functionName,
    functionVersion: '$LATEST',
    invokedFunctionArn: `arn:aws:lambda:us-east-1:000000000000:function:${functionName}`,
    memoryLimitInMB: '1024',
    awsRequestId: crypto.randomUUID(),
    logGroupName: `/aws/lambda/${functionName}`,
    logStreamName: 'local',
    callbackWaitsForEmptyEventLoop: true,
    getRemainingTimeInMillis: () => 900000,
    done: () => {},
    fail: () => {},
    succeed: () => {},
  };
}

function buildFakeEvent(opts: {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: `${opts.method} ${opts.path}`,
    rawPath: opts.path,
    rawQueryString: '',
    headers: opts.headers,
    requestContext: {
      accountId: '000000000000',
      apiId: 'local',
      domainName: 'localhost',
      domainPrefix: 'localhost',
      http: {
        method: opts.method,
        path: opts.path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: opts.headers['user-agent'] ?? 'sluice-dev',
      },
      requestId: crypto.randomUUID(),
      routeKey: `${opts.method} ${opts.path}`,
      stage: '$default',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    body: opts.body ?? undefined,
    isBase64Encoded: false,
  };
}

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token',
  'access-control-max-age': '86400',
};

type RouteEntry = {
  lambdaFunctionName: string;
  module: string;
  exportName: string;
  environment?: Record<string, string>;
};

export async function startDevServer(opts: {
  routeTable: RouteTable;
  handlerBaseDir: string;
  port?: number;
  stage?: string;
  prefix?: string;
}) {
  const port = opts.port ?? 3000;
  const stage = opts.stage ?? 'dev';
  const baseDir = resolve(opts.handlerBaseDir);
  const service = opts.routeTable.service;
  const prefix = opts.prefix ?? opts.routeTable.prefix;

  for (const [key, value] of Object.entries(opts.routeTable.providerEnvironment)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  // Inject AWS_REGION / AWS_DEFAULT_REGION like Serverless Framework does
  const region = opts.routeTable.region;
  if (region) {
    if (process.env['AWS_REGION'] === undefined) {
      process.env['AWS_REGION'] = region;
    }
    if (process.env['AWS_DEFAULT_REGION'] === undefined) {
      process.env['AWS_DEFAULT_REGION'] = region;
    }
  }

  const routeLookup = new Map<string, RouteEntry>();
  for (const route of opts.routeTable.routes) {
    const key = `${route.method} ${route.path}`;
    const modulePath = route.module.startsWith('./')
      ? resolve(baseDir, route.module.slice(2))
      : resolve(baseDir, route.module);
    routeLookup.set(key, {
      lambdaFunctionName: buildLambdaFunctionName(service, stage, route.functionName),
      module: modulePath,
      exportName: route.exportName,
      environment: route.environment,
    });
  }

  const resolved = new Map<string, Handler>();

  const server = createServer(async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    let path = url.pathname;

    // Strip prefix if present (e.g. /dashboard-v2-http/create-customer → /create-customer)
    if (prefix && path.startsWith(`/${prefix}`)) {
      path = path.slice(prefix.length + 1) || '/';
    }

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    const key = `${method} ${path}`;
    const entry = routeLookup.get(key);

    if (!entry) {
      res.writeHead(404, { 'content-type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ error: `No handler for ${method} ${path}` }));
      return;
    }

    const envSnapshot: Record<string, string | undefined> = {};
    if (entry.environment) {
      for (const [key, value] of Object.entries(entry.environment)) {
        envSnapshot[key] = process.env[key];
        process.env[key] = value;
      }
    }

    let body = '';
    for await (const chunk of req) body += chunk;

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(', ');
    }

    const event = buildFakeEvent({ method, path, headers, body: body || null });
    const context = buildFakeContext(entry.lambdaFunctionName);

    try {
      let fn = resolved.get(key);
      if (!fn) {
        const mod = await import(entry.module);
        fn = mod[entry.exportName] as Handler;
        if (!fn) {
          res.writeHead(500, { 'content-type': 'application/json', ...CORS_HEADERS });
          res.end(JSON.stringify({ error: `Export '${entry.exportName}' not found in ${entry.module}` }));
          return;
        }
        resolved.set(key, fn);
      }

      const start = performance.now();
      const result = await fn(event, context);
      const elapsed = (performance.now() - start).toFixed(0);

      const statusCode = result.statusCode ?? 200;
      console.log(`${method} ${path} → ${statusCode} (${elapsed}ms)`);

      const responseHeaders: Record<string, string> = {
        'content-type': 'application/json',
        ...CORS_HEADERS,
      };
      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) {
          if (v !== undefined) responseHeaders[k] = String(v);
        }
      }

      res.writeHead(statusCode, responseHeaders);
      res.end(result.body ?? '');
    } catch (err) {
      console.error(`${method} ${path} → 500`, err);
      res.writeHead(500, { 'content-type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ error: String(err) }));
    } finally {
      if (entry.environment) {
        for (const [key, original] of Object.entries(envSnapshot)) {
          if (original === undefined) delete process.env[key];
          else process.env[key] = original;
        }
      }
    }
  });

  server.listen(port, () => {
    console.log(`sluice dev server listening on http://localhost:${port}`);
    console.log(`service: ${service}, stage: ${stage}${prefix ? `, prefix: /${prefix}` : ''}`);
    console.log(`${opts.routeTable.routes.length} routes loaded`);
    if (prefix) {
      console.log(`\nRequests to /${prefix}/* will be routed with prefix stripped`);
    }
    console.log('');
    for (const route of opts.routeTable.routes) {
      const fullPath = prefix ? `/${prefix}${route.path}` : route.path;
      console.log(`  ${route.method.padEnd(6)} ${fullPath}`);
    }
    console.log('');
  });

  return server;
}
