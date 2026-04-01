export type Route = {
  functionName: string;
  method: string;
  path: string;
  handler: string;
  module: string;
  exportName: string;
  environment?: Record<string, string>;
};

export type RouteTable = {
  service: string;
  routes: Route[];
  providerEnvironment: Record<string, string>;
  prefix?: string;
};

export type SluiceConfig = {
  serverlessFile?: string;
  basePath?: string;
  port?: number;
  stage?: string;
};
