# sluice

Bundle Serverless Framework functions into a single Lambda with a router. Designed for PR preview deploys and local dev — avoids deploying N separate Lambda functions per commit.

## Install

```bash
npm install sluice
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

Handlers are loaded lazily on first request via dynamic `import()`.

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
| `--out`, `-o` | varies | Output path |
| `--base-path` | directory of serverless.yml | Handler source directory |
| `--stack-name` | `sluice-<service>` | CloudFormation stack name |
| `--minify` | off | Minify the bundle |
| `--external` | `@aws-sdk/*` | Comma-separated externals |

## Programmatic API

```typescript
import { parseServerlessYml, startDevServer, buildAndPackage } from 'sluice';

const routeTable = parseServerlessYml('serverless.yml');

// dev server
await startDevServer({ routeTable, handlerBaseDir: '.', port: 3000 });

// build
await buildAndPackage({
  routeTable,
  handlerBaseDir: '.',
  outDir: '.sluice-build',
});
```

## How it works

1. **Parse** — reads `serverless.yml`, extracts `functions.*.events[].httpApi` routes
2. **Generate** — emits a router that maps `METHOD /path` → dynamic `import('./handler')`
3. **Bundle** — esbuild bundles the router + all handlers into one file with tree-shaking
4. **Deploy** — SAM template defines one Lambda with a catch-all `/{proxy+}` route

The router caches resolved handler imports after first invocation, so cold start only pays for the handler that's actually called.

## Limitations

- Only handles `httpApi` and `http` events. Scheduled, SQS, SNS, and stream triggers are ignored.
- Serverless Framework variable syntax (`${self:...}`, `${ssm:...}`, etc.) is stripped during parsing — only the function/event structure matters.
- The single Lambda gets a union of whatever IAM permissions you configure in SAM, not per-function roles.
