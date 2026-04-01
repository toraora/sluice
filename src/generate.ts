import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { RouteTable } from './types.js';
import { parseServerlessYml } from './parser.js';

export function generateRouterSource(routeTable: RouteTable, handlerBasePath: string): string {
  const lines: string[] = [];

  lines.push(`import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda';`);
  lines.push('');
  lines.push('type Handler = (event: APIGatewayProxyEventV2, context: Context) => Promise<APIGatewayProxyStructuredResultV2>;');
  lines.push('');
  lines.push('type RouteEntry = {');
  lines.push('  method: string;');
  lines.push('  load: () => Promise<Handler>;');
  lines.push('};');
  lines.push('');
  lines.push('const routes: Record<string, RouteEntry> = {');

  for (const route of routeTable.routes) {
    const importPath = route.module.startsWith('./')
      ? `${handlerBasePath}/${route.module.slice(2)}`
      : `${handlerBasePath}/${route.module}`;

    const key = `${route.method} ${route.path}`;
    lines.push(`  '${key}': {`);
    lines.push(`    method: '${route.method}',`);
    lines.push(`    load: async () => (await import('${importPath}')).${route.exportName},`);
    lines.push(`  },`);
  }

  lines.push('};');
  lines.push('');
  lines.push('const resolved = new Map<string, Handler>();');
  lines.push('');
  lines.push('export async function handler(');
  lines.push('  event: APIGatewayProxyEventV2,');
  lines.push('  context: Context,');
  lines.push('): Promise<APIGatewayProxyStructuredResultV2> {');
  lines.push('  const method = event.requestContext?.http?.method ?? "POST";');
  lines.push('  const rawPath = event.rawPath ?? "/";');
  lines.push('  const key = `${method} ${rawPath}`;');
  lines.push('');
  lines.push('  let fn = resolved.get(key);');
  lines.push('  if (!fn) {');
  lines.push('    const entry = routes[key];');
  lines.push('    if (!entry) {');
  lines.push('      return { statusCode: 404, body: JSON.stringify({ error: `No handler for ${method} ${rawPath}` }) };');
  lines.push('    }');
  lines.push('    fn = await entry.load();');
  lines.push('    resolved.set(key, fn);');
  lines.push('  }');
  lines.push('');
  lines.push('  return fn(event, context);');
  lines.push('}');

  return lines.join('\n');
}

export function generateRouterFile(opts: {
  serverlessFile: string;
  outputFile: string;
  handlerBasePath?: string;
}): RouteTable {
  const routeTable = parseServerlessYml(opts.serverlessFile);
  const handlerBasePath = opts.handlerBasePath ?? '.';
  const source = generateRouterSource(routeTable, handlerBasePath);
  const outDir = dirname(resolve(opts.outputFile));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(opts.outputFile, source, 'utf8');
  return routeTable;
}
