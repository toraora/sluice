import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { build } from 'esbuild';
import type { RouteTable } from './types.js';
import { generateRouterSource } from './generate.js';

function generateSamTemplate(opts: {
  service: string;
  stackName: string;
  memorySize?: number;
  timeout?: number;
  runtime?: string;
  environment?: Record<string, string>;
}): string {
  const memory = opts.memorySize ?? 1024;
  const timeout = opts.timeout ?? 900;
  const runtime = opts.runtime ?? 'nodejs18.x';

  const envLines = opts.environment
    ? Object.entries(opts.environment)
        .map(([k, v]) => `          ${k}: '${v}'`)
        .join('\n')
    : '';

  const envBlock = envLines
    ? `\n      Environment:\n        Variables:\n${envLines}`
    : '';

  return `AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2016-10-31
Description: ${opts.service} - sluice single-lambda deploy

Globals:
  Function:
    Timeout: ${timeout}
    MemorySize: ${memory}
    Runtime: ${runtime}

Resources:
  SluiceFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: handler.handler
      CodeUri: ./bundle/${envBlock}
      FunctionUrlConfig:
        AuthType: NONE
      Events:
        CatchAll:
          Type: HttpApi
          Properties:
            Path: /{proxy+}
            Method: ANY

Outputs:
  FunctionUrl:
    Description: Lambda Function URL
    Value: !GetAtt SluiceFunctionUrl.FunctionUrl
  ApiUrl:
    Description: HTTP API URL
    Value: !Sub 'https://\${ServerlessHttpApi}.execute-api.\${AWS::Region}.amazonaws.com'
`;
}

export async function buildAndPackage(opts: {
  routeTable: RouteTable;
  handlerBaseDir: string;
  outDir: string;
  stackName?: string;
  memorySize?: number;
  timeout?: number;
  runtime?: string;
  environment?: Record<string, string>;
  minify?: boolean;
  sourcemap?: boolean;
  external?: string[];
}) {
  const outDir = resolve(opts.outDir);
  const bundleDir = resolve(outDir, 'bundle');
  mkdirSync(bundleDir, { recursive: true });

  const handlerBasePath = '.';
  const routerSource = generateRouterSource(opts.routeTable, handlerBasePath);

  const entryFile = resolve(outDir, '_sluice_entry.ts');
  writeFileSync(entryFile, routerSource, 'utf8');

  const absDir = resolve(opts.handlerBaseDir);

  await build({
    entryPoints: [entryFile],
    outfile: resolve(bundleDir, 'handler.js'),
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    minify: opts.minify ?? false,
    sourcemap: opts.sourcemap ?? true,
    external: opts.external ?? ['@aws-sdk/*'],
    absWorkingDir: absDir,
    // resolve handler imports relative to the handler base dir
    alias: { '.': absDir },
  });

  const stackName = opts.stackName ?? `sluice-${opts.routeTable.service}`;
  const template = generateSamTemplate({
    service: opts.routeTable.service,
    stackName,
    memorySize: opts.memorySize,
    timeout: opts.timeout,
    runtime: opts.runtime,
    environment: opts.environment,
  });

  writeFileSync(resolve(outDir, 'template.yaml'), template, 'utf8');

  return { bundleDir, templateFile: resolve(outDir, 'template.yaml'), stackName };
}
