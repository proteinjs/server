import { Route } from '@proteinjs/server-api';
import { GracefulShutdown } from '../GracefulShutdown';

/**
 * Readiness: 200 while serving, 503 once GracefulShutdown has begun draining (SIGTERM
 * received) — load balancers and kubelet readiness probes read this route, and the 503 is
 * what makes them stop routing new traffic while in-flight requests finish.
 */
export const healthCheck: Route = {
  path: 'health-check',
  method: 'get',
  useHttp: true,
  onRequest: async (request, response): Promise<void> => {
    if (GracefulShutdown.isShuttingDown()) {
      response.status(503).send('draining');
      return;
    }

    response.send();
  },
};
