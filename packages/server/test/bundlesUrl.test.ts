import { BundlesUrl } from '../src/BundlesUrl';

/**
 * The declared bundles URL (`ServerConfig.staticContent.bundlesUrl`) as the server reads it: an
 * absolute http(s) URL, a trailing slash dropped, a path kept; anything else refused by name at
 * config time — a page that named a malformed origin would fail in every browser instead.
 */
describe('BundlesUrl', () => {
  const declared = (bundlesUrl: unknown) =>
    BundlesUrl.declared({ staticContent: { bundlesDir: 'bundles', bundlesUrl } } as any);

  it('is undefined when nothing is declared — the bundles are served by this process', () => {
    expect(BundlesUrl.declared({} as any)).toBeUndefined();
    expect(BundlesUrl.declared({ staticContent: { bundlesDir: 'bundles' } } as any)).toBeUndefined();
  });

  it('names a bundle under the declared base, with a trailing slash on the base dropped', () => {
    expect(declared('https://assets.example.com/bundles/')!.urlFor('app.1a2b3c.js')).toBe(
      'https://assets.example.com/bundles/app.1a2b3c.js'
    );
    expect(declared('https://assets.example.com/bundles')!.urlFor('app.1a2b3c.js')).toBe(
      'https://assets.example.com/bundles/app.1a2b3c.js'
    );
    expect(declared('https://assets.example.com')!.urlFor('vendor.9f8e7d.js')).toBe(
      'https://assets.example.com/vendor.9f8e7d.js'
    );
    expect(String(declared('https://assets.example.com/bundles/'))).toBe('https://assets.example.com/bundles');
  });

  it('keeps a nested path under the bundles dir as path segments', () => {
    expect(declared('https://assets.example.com/bundles')!.urlFor('images/mark.4d5e6f.svg')).toBe(
      'https://assets.example.com/bundles/images/mark.4d5e6f.svg'
    );
  });

  it('accepts plain http for a local or test origin', () => {
    expect(declared('http://localhost:8080/bundles')!.urlFor('app.js')).toBe('http://localhost:8080/bundles/app.js');
  });

  it('refuses a value that is not an absolute http(s) URL without query or fragment, naming the field', () => {
    for (const bad of ['', 'assets.example.com/bundles', '/static/bundles', 'ftp://assets.example.com/bundles']) {
      expect(() => declared(bad)).toThrow(/staticContent\.bundlesUrl/);
    }
    expect(() => declared('https://assets.example.com/bundles?v=1')).toThrow(/query/);
    expect(() => declared('https://assets.example.com/bundles#x')).toThrow(/fragment/);
  });
});
