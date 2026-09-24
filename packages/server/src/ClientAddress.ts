/** The request fields the read needs — an express request has all of them. */
type ClientRequest = {
  app?: { get?: (setting: string) => unknown };
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
};

/**
 * The client's address, as a server should key on it — a throttle's window, a refusal line's device
 * hash.
 *
 * Behind a load balancer that appends to `X-Forwarded-For` (the common application load balancer
 * format), the header ENDS with the two entries the balancer appends —
 * `<client-ip>,<load-balancer-ip>` — and everything before them is whatever the client itself
 * sent. So the client is the second entry from the right:
 * - never the LAST entry: that is the balancer's own forwarding-rule address, the same for every
 *   visitor. It is what express's `request.ip` resolves to under the server's `trust proxy 1`
 *   (one trusted hop: the balancer's front end that opened the connection), so a throttle keyed on
 *   `request.ip` there is one bucket for the whole world;
 * - never the FIRST entry: a client can send its own header, and the balancer keeps it.
 *
 * Only when the server trusts a proxy (the deployed shape; `trust proxy` is unset in
 * development) is the header read at all. A request that did not come through the balancer —
 * no appended pair: an in-cluster call, a probe — and every request in development key on the
 * connection's own address.
 */
export class ClientAddress {
  /** How many entries the load balancer appends to the header: the client, then itself. */
  private static readonly BALANCER_APPENDED_ENTRIES = 2;

  of(request: ClientRequest): string {
    if (request.app?.get?.('trust proxy')) {
      const entries = this.forwardedFor(request);
      if (entries.length >= ClientAddress.BALANCER_APPENDED_ENTRIES) {
        return entries[entries.length - ClientAddress.BALANCER_APPENDED_ENTRIES];
      }
    }
    return request.socket?.remoteAddress ?? '';
  }

  private forwardedFor(request: ClientRequest): string[] {
    const header = request.headers?.['x-forwarded-for'];
    const value = Array.isArray(header) ? header.join(',') : (header ?? '');
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
}
