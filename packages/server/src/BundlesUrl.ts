import { ServerConfig } from '@proteinjs/server-api';

/**
 * The declared place the bundles are served from (`ServerConfig.staticContent.bundlesUrl`), read
 * once at config time: validated, normalized (a trailing slash dropped) and turned into the URLs
 * the page names and the redirect the server answers for its own bundles path (startServer.ts).
 * A malformed declaration is refused here, by name, so the boot fails instead of every browser.
 */
export class BundlesUrl {
  private constructor(private readonly base: string) {}

  /**
   * The declaration, or undefined when the bundles are served by this process. Throws on a
   * value that is not an absolute http(s) URL, or one carrying a query or a fragment.
   */
  static declared(config: ServerConfig): BundlesUrl | undefined {
    const value = config.staticContent?.bundlesUrl;
    if (value === undefined) {
      return undefined;
    }

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`staticContent.bundlesUrl must be an absolute http(s) URL, got ${JSON.stringify(value)}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`staticContent.bundlesUrl must be an http(s) URL, got ${JSON.stringify(value)}`);
    }
    if (url.search) {
      throw new Error(`staticContent.bundlesUrl must carry no query, got ${JSON.stringify(value)}`);
    }
    if (url.hash) {
      throw new Error(`staticContent.bundlesUrl must carry no fragment, got ${JSON.stringify(value)}`);
    }

    return new BundlesUrl(url.toString().replace(/\/+$/, ''));
  }

  /** The URL of the bundle at `relativePath` — a path under `bundlesDir`, in that dir's own separators. */
  urlFor(relativePath: string): string {
    const segments = relativePath.split(/[\\/]+/).filter((segment) => segment.length > 0);
    return `${this.base}/${segments.join('/')}`;
  }

  toString(): string {
    return this.base;
  }
}
