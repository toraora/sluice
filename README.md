# sluice

Bundle Serverless Framework functions into a single Lambda with a router. Designed for PR preview deploys and local dev — avoids deploying N separate Lambda functions per commit.

## Install

```bash
npm install @tora-dev/sluice
```

For TypeScript handler projects, you also need `tsx` as a peer:

```bash
npm install -D tsx
```

## CLI

### Print routes

```bash
sluice routes --config path/to/serverless.yml
```

### Local dev server

Starts an HTTP server that dispatches requests to your Lambda handlers using fake API Gateway v2.0 events.

```bash
sluice dev --config path/to/serverless.yml --port 3000
```

Handlers are loaded lazily on first request via dynamic `import()`. The dev server automatically:

- Strips URL prefixes detected from `custom.serverless-offline.prefix` or `custom.customDomain` config
- Injects `AWS_REGION` and `AWS_DEFAULT_REGION` from `provider.region`
- Sets `provider.environment` variables (won't overwrite existing env vars)
- Applies per-function environment overrides for the duration of each request
- Adds CORS headers to all responses and handles OPTIONS preflight

#### TypeScript handlers

If your handlers are TypeScript files, run sluice with `tsx` as the interpreter:

```json
{
  "scripts": {
    "sluice:dev": "tsx node_modules/@tora-dev/sluice/dist/cli.js dev --config path/to/serverless.yml --port 3000"
  }
}
```

Plain `sluice` uses the `node` shebang and can't import `.ts` files natively.

### Resolve environment variables

Resolves all Serverless Framework variable syntax (`${self:...}`, `${env:...}`, `${file(...):...}`, `${ssm:...}`) in `provider.environment` and per-function environments, then writes a `.env` file.

```bash
sluice resolve-env --config path/to/serverless.yml --stage dev --out .env.dev
```

Supports `--skip-ssm` to resolve everything except SSM parameters (useful for fast iteration without AWS credentials). Unresolvable variables are commented out in the output.

#### Multi-stage workflow

Generate separate `.env` files per stage and start the dev server against each:

```json
{
  "scripts": {
    "sluice:resolve:dev": "sluice resolve-env --config lambda/my-service/serverless.yml --stage dev --out .env.dev",
    "sluice:resolve:prod": "sluice resolve-env --config lambda/my-service/serverless.yml --stage prod --out .env.prod",
    "sluice:serve:dev": "tsx node_modules/@tora-dev/sluice/dist/cli.js dev --config lambda/my-service/serverless.yml --env-file .env.dev --stage dev --port 3000",
    "sluice:serve:prod": "tsx node_modules/@tora-dev/sluice/dist/cli.js dev --config lambda/my-service/serverless.yml --env-file .env.prod --stage prod --port 3001"
  }
}
```

### Generate router

Emits a TypeScript file that maps routes to handler imports. Useful if you want to customize the router or inspect it.

```bash
sluice generate --config path/to/serverless.yml --out sluice-router.ts
```

### Build for deploy

Bundles all handlers into a single file using esbuild and generates a SAM template.

```bash
sluice build --config path/to/serverless.yml --out .sluice-build
```

Then deploy with SAM:

```bash
sam deploy \
  --template-file .sluice-build/template.yaml \
  --stack-name sluice-my-service-pr-123 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3
```

Tear down when the PR closes:

```bash
sam delete --stack-name sluice-my-service-pr-123 --no-prompts
```

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--config`, `-c` | `./serverless.yml` | Path to serverless.yml |
| `--port`, `-p` | `3000` | Dev server port |
| `--stage`, `-s` | `dev` | Stage name for function naming and variable resolution |
| `--prefix` | auto-detected | URL prefix to strip |
| `--env-file` | `.env` in config directory | Load environment variables from a file |
| `--region` | from AWS config | AWS region for SSM lookups |
| `--skip-ssm` | off | Skip SSM parameter resolution (resolve-env only) |
| `--out`, `-o` | varies | Output path |
| `--base-path` | directory of serverless.yml | Handler source directory |
| `--stack-name` | `sluice-<service>` | CloudFormation stack name |
| `--minify` | off | Minify the bundle |
| `--external` | `@aws-sdk/*` | Comma-separated externals |

## Programmatic API

```typescript
import { parseServerlessYml, startDevServer, buildAndPackage, resolveEnvironment, writeEnvFile } from '@tora-dev/sluice';

const routeTable = parseServerlessYml('serverless.yml');

// dev server
await startDevServer({ routeTable, handlerBaseDir: '.', port: 3000 });

// build
await buildAndPackage({
  routeTable,
  handlerBaseDir: '.',
  outDir: '.sluice-build',
});

// resolve env and write .env file
const env = await resolveEnvironment({
  serverlessFile: 'serverless.yml',
  stage: 'dev',
});
writeEnvFile(env, '.env');
```

## How it works

1. **Parse** — reads `serverless.yml`, extracts `functions.*.events[].httpApi` routes, `provider.region`, and environment variables. Serverless variable syntax is stripped for route parsing; use `resolve-env` to fully resolve variables including SSM parameters.
2. **Generate** — emits a router that maps `METHOD /path` to dynamic `import('./handler')`
3. **Bundle** — esbuild bundles the router + all handlers into one file with tree-shaking
4. **Deploy** — SAM template defines one Lambda with a catch-all `/{proxy+}` route

The router caches resolved handler imports after first invocation, so cold start only pays for the handler that's actually called.

## Limitations

- Only handles `httpApi` and `http` events. Scheduled, SQS, SNS, and stream triggers are ignored.
- Nested Serverless variable syntax (`${ssm:param-${sls:stage}}`) is partially handled during route parsing — the sanitizer strips from `${` to the first `}`, which can leave trailing characters. Environment values affected by this are excluded from the parsed route table. Use `resolve-env` for full variable resolution.
- The single Lambda gets a union of whatever IAM permissions you configure in SAM, not per-function roles.
- `queryStringParameters` are not currently populated in the fake API Gateway event during dev server mode.
