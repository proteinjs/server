import { ClientAddress } from '../src/ClientAddress';

/**
 * Which address a throttle keys on. Behind a load balancer that appends to X-Forwarded-For, the
 * header ends `<client-ip>,<load-balancer-ip>` — the balancer appends both, and anything before
 * them is whatever the client itself sent. So the client is the SECOND entry from the right:
 * never the last (the balancer's own address, the same for every visitor — a throttle keyed on
 * it is one bucket for the whole world) and never the first (client-supplied, rotatable at will).
 */
describe('ClientAddress', () => {
  const behindTheBalancer = (forwardedFor: string | undefined, socketAddress = '35.191.0.10') => ({
    app: { get: (setting: string) => (setting === 'trust proxy' ? 1 : undefined) },
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    socket: { remoteAddress: socketAddress },
    // What express's own `request.ip` resolves to under `trust proxy 1`: the header's last entry.
    ip: forwardedFor?.split(',').pop()?.trim() ?? socketAddress,
  });

  it("reads the client the balancer appended, not the balancer's own address", () => {
    const request = behindTheBalancer('198.51.100.23, 34.120.1.1');

    expect(new ClientAddress().of(request)).toBe('198.51.100.23');
    expect(request.ip).toBe('34.120.1.1');
  });

  it('ignores whatever the client put in the header itself', () => {
    const spoofed = behindTheBalancer('203.0.113.99, 10.0.0.1, 198.51.100.23, 34.120.1.1');

    expect(new ClientAddress().of(spoofed)).toBe('198.51.100.23');
  });

  it('reads IPv6 clients the same way', () => {
    expect(new ClientAddress().of(behindTheBalancer('2001:db8:1:2:3:4:5:6,34.120.1.1'))).toBe('2001:db8:1:2:3:4:5:6');
  });

  it('a request that did not come through the balancer (no appended pair) keys on its own connection', () => {
    expect(new ClientAddress().of(behindTheBalancer(undefined, '10.8.0.7'))).toBe('10.8.0.7');
    expect(new ClientAddress().of(behindTheBalancer('10.8.0.9', '10.8.0.7'))).toBe('10.8.0.7');
  });

  it('with no proxy trusted (development) the connection is the client, and a forwarded header is ignored', () => {
    const direct = {
      app: { get: () => false },
      headers: { 'x-forwarded-for': '203.0.113.99, 198.51.100.23' },
      socket: { remoteAddress: '::1' },
    };

    expect(new ClientAddress().of(direct)).toBe('::1');
  });

  it('a request with no connection details at all reads as the empty address', () => {
    expect(new ClientAddress().of({})).toBe('');
  });
});
