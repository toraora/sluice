import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';
import type { RouteTable } from './types.js';

type Handler = (event: APIGatewayProxyEventV2, context: Context) => Promise<APIGatewayProxyStructuredResultV2>;

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

export async function startDevServer(opts: {
  routeTable: RouteTable;
  handlerBaseDir: string;
  port?: number;
}) {
  const port = opts.port ?? 3000;
  const baseDir = resolve(opts.handlerBaseDir);

  const routeLookup = new Map<string, { functionName: string; module: string; exportName: string }>();
  for (const route of opts.routeTable.routes) {
    const key = `${route.method} ${route.path}`;
    const modulePath = route.module.startsWith('./')
      ? resolve(baseDir, route.module.slice(2))
      : resolve(baseDir, route.module);
    routeLookup.set(key, {
      functionName: route.functionName,
      module: modulePath,
      exportName: route.exportName,
    });
  }

  const resolved = new Map<string, Handler>();

  const server = createServer(async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const path = url.pathname;

    const key = `${method} ${path}`;
    const entry = routeLookup.get(key);

    if (!entry) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `No handler for ${method} ${path}` }));
      return;
    }

    let body = '';
    for await (const chunk of req) body += chunk;

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(', ');
    }

    const event = buildFakeEvent({ method, path, headers, body: body || null });
    const context = buildFakeContext(entry.functionName);

    try {
      let fn = resolved.get(key);
      if (!fn) {
        const mod = await import(entry.module);
        fn = mod[entry.exportName] as Handler;
        if (!fn) {
          res.writeHead(500, { 'content-type': 'application/json' });
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

      const responseHeaders: Record<string, string> = { 'content-type': 'application/json' };
      if (result.headers) {
        for (const [k, v] of Object.entries(result.headers)) {
          if (v !== undefined) responseHeaders[k] = String(v);
        }
      }

      res.writeHead(statusCode, responseHeaders);
      res.end(result.body ?? '');
    } catch (err) {
      console.error(`${method} ${path} → 500`, err);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  server.listen(port, () => {
    console.log(`sluice dev server listening on http://localhost:${port}`);
    console.log(`${opts.routeTable.routes.length} routes loaded from ${opts.routeTable.service}`);
    console.log('');
    for (const route of opts.routeTable.routes) {
      console.log(`  ${route.method.padEnd(6)} ${route.path}`);
    }
    console.log('');
  });

  return server;
}
