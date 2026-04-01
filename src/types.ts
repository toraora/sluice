export type Route = {
  functionName: string;
  method: string;
  path: string;
  handler: string;
  module: string;
  exportName: string;
};

export type RouteTable = {
  service: string;
  routes: Route[];
};

export type SluiceConfig = {
  serverlessFile?: string;
  basePath?: string;
  port?: number;
};
