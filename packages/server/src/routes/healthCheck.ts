import { Route } from '@proteinjs/server-api';

export const healthCheck: Route = {
  path: 'health-check',
  method: 'get',
  useHttp: true,
  onRequest: async (request, response): Promise<void> => {
    response.send();
  },
};
