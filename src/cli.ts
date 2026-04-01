#!/usr/bin/env node

import { resolve } from 'node:path';
import { parseServerlessYml } from './parser.js';
import { generateRouterFile } from './generate.js';
import { startDevServer } from './dev-server.js';
import { buildAndPackage } from './deploy.js';

const args = process.argv.slice(2);
const command = args[0];

function flag(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function usage(): never {
  console.log(`sluice - single-lambda router for Serverless Framework projects

Commands:
  dev       Start a local dev server
  generate  Generate a router file from serverless.yml
  build     Bundle all handlers + generate SAM template
  routes    Print the route table

Options:
  --config, -c    Path to serverless.yml (default: ./serverless.yml)
  --port, -p      Dev server port (default: 3000)
  --out, -o       Output path for generate/build
  --base-path     Handler base directory (default: directory of serverless.yml)
  --stack-name    CloudFormation stack name (default: sluice-<service>)
  --minify        Minify the bundle
  --external      Comma-separated externals (default: @aws-sdk/*)
`);
  process.exit(1);
}

async function main() {
  if (!command || command === '--help' || command === '-h') usage();

  const configPath = resolve(flag('--config') ?? flag('-c') ?? 'serverless.yml');
  const configDir = resolve(configPath, '..');

  if (command === 'routes') {
    const routeTable = parseServerlessYml(configPath);
    console.log(`${routeTable.service}: ${routeTable.routes.length} routes\n`);
    for (const route of routeTable.routes) {
      console.log(`  ${route.method.padEnd(6)} ${route.path}  →  ${route.handler}`);
    }
    return;
  }

  if (command === 'generate') {
    const outFile = resolve(flag('--out') ?? flag('-o') ?? 'sluice-router.ts');
    const basePath = flag('--base-path') ?? '.';
    const routeTable = generateRouterFile({
      serverlessFile: configPath,
      outputFile: outFile,
      handlerBasePath: basePath,
    });
    console.log(`Generated router with ${routeTable.routes.length} routes → ${outFile}`);
    return;
  }

  if (command === 'dev') {
    const port = parseInt(flag('--port') ?? flag('-p') ?? '3000', 10);
    const baseDir = resolve(flag('--base-path') ?? configDir);
    const routeTable = parseServerlessYml(configPath);
    await startDevServer({ routeTable, handlerBaseDir: baseDir, port });
    return;
  }

  if (command === 'build') {
    const outDir = resolve(flag('--out') ?? flag('-o') ?? '.sluice-build');
    const baseDir = resolve(flag('--base-path') ?? configDir);
    const stackName = flag('--stack-name');
    const minify = args.includes('--minify');
    const externalStr = flag('--external');
    const external = externalStr ? externalStr.split(',') : undefined;

    const routeTable = parseServerlessYml(configPath);
    console.log(`Building ${routeTable.routes.length} routes from ${routeTable.service}...`);

    const result = await buildAndPackage({
      routeTable,
      handlerBaseDir: baseDir,
      outDir,
      stackName,
      minify,
      external,
    });

    console.log(`Bundle → ${result.bundleDir}`);
    console.log(`SAM template → ${result.templateFile}`);
    console.log(`\nDeploy with:`);
    console.log(`  sam deploy --template-file ${result.templateFile} --stack-name ${result.stackName} --capabilities CAPABILITY_IAM --resolve-s3`);
    return;
  }

  console.error(`Unknown command: ${command}`);
  usage();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
