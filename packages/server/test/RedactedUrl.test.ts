import { RedactedUrl } from '../src/RedactedUrl';

/**
 * The redacted form's edges, on the class itself (the request logging suite proves the lines that
 * print it; this suite pins the form on the shapes a real url can take). The rule under test: the
 * path exactly as it came, then `?`, then every query piece as `key=<redacted>` — the key printed
 * verbatim (never decoded, never re-encoded, never merged with a repeat), the value gone whatever
 * it held, however it was encoded, and however many pieces there are; then, from the first `#`, the
 * fragment as `#<redacted>` whatever it held, with or without a query before it.
 */
describe('RedactedUrl', () => {
  const mark = RedactedUrl.MARK;

  it('a repeated key: every occurrence kept, every value gone', () => {
    expect(RedactedUrl.of('/p?a=1&a=2&a=3')).toBe(`/p?a=${mark}&a=${mark}&a=${mark}`);
  });

  it('a percent-encoded value never surfaces through decoding: the key is printed as sent, the value is gone', () => {
    // `%3D` and `%26` are an encoded `=` and `&` inside ONE value — a form that decodes into two
    // pieces or a second `=` if anything decodes before it splits.
    expect(RedactedUrl.of('/p?token=abc%3Ddef%26other%3Dsecret')).toBe(`/p?token=${mark}`);
    // An encoded key stays exactly as it came — the log never re-spells what the request said.
    expect(RedactedUrl.of('/p?to%3Dken=secret')).toBe(`/p?to%3Dken=${mark}`);
  });

  it('an empty value still prints the mark, not an empty value', () => {
    expect(RedactedUrl.of('/p?token=')).toBe(`/p?token=${mark}`);
    expect(RedactedUrl.of('/p?token=&other=')).toBe(`/p?token=${mark}&other=${mark}`);
  });

  it('an empty key is all value: `=<mark>`', () => {
    expect(RedactedUrl.of('/p?=secret')).toBe(`/p?=${mark}`);
  });

  it('the first `?` starts the query; a later `?` is inside a value and goes with it', () => {
    // A `?` cannot occur in a path segment unencoded — the first one IS the query delimiter.
    expect(RedactedUrl.of('/a?b?c=1')).toBe(`/a?b?c=${mark}`);
    expect(RedactedUrl.of('/p?next=/x?y=1&z=2')).toBe(`/p?next=${mark}&z=${mark}`);
    // An ENCODED `?` in the path is path: printed as it came, the query after the real `?`.
    expect(RedactedUrl.of('/a%3Fb/c?token=secret')).toBe(`/a%3Fb/c?token=${mark}`);
  });

  it('a semicolon is not a separator here: the piece is one key and one value', () => {
    expect(RedactedUrl.of('/p?a=1;b=2')).toBe(`/p?a=${mark}`);
  });

  it('empty pieces and a trailing separator print as they came', () => {
    expect(RedactedUrl.of('/p?a=1&&b=2&')).toBe(`/p?a=${mark}&&b=${mark}&`);
    expect(RedactedUrl.of('/p?')).toBe('/p?');
  });

  it('an absolute-form target keeps its origin and path', () => {
    expect(RedactedUrl.of('http://host.example/p?token=secret')).toBe(`http://host.example/p?token=${mark}`);
  });

  it('a fragment with no query: its content never prints, the mark stands in its place', () => {
    // A link can carry a credential in its fragment (`#access=…`, kept out of the query so no server
    // or balancer receives it) — and the page's `location.href`, which a client error report names,
    // still holds it.
    expect(RedactedUrl.of('/invite#access=frag-only-secret')).toBe(`/invite#${mark}`);
    expect(RedactedUrl.of('http://host.example/#access=frag-only-secret')).toBe(`http://host.example/#${mark}`);
    expect(RedactedUrl.of('/p#bare-secret')).toBe(`/p#${mark}`);
  });

  it('a query and a fragment: every value marked and the fragment marked on its own — the same fragment shape as with no query', () => {
    expect(RedactedUrl.of('/p?id=7#access=secret')).toBe(`/p?id=${mark}#${mark}`);
    expect(RedactedUrl.of('/p?id=7&next=x#secret')).toBe(`/p?id=${mark}&next=${mark}#${mark}`);
    expect(RedactedUrl.of('/p?#secret')).toBe(`/p?#${mark}`);
  });

  it('the first `#` starts the fragment: a `?`, `=` or `&` after it is fragment, never query', () => {
    // A fragment can hold a query-looking run; none of it is a key the log may keep.
    expect(RedactedUrl.of('/p#a=1?token=secret')).toBe(`/p#${mark}`);
    expect(RedactedUrl.of('/p#?token=secret&other=x')).toBe(`/p#${mark}`);
    expect(RedactedUrl.of('/p?next=/x#y?z=secret')).toBe(`/p?next=${mark}#${mark}`);
    // A second `#` is inside the fragment and goes with it.
    expect(RedactedUrl.of('/p#one#two=secret')).toBe(`/p#${mark}`);
  });

  it('an empty fragment prints as it came; an ENCODED `#` is path or value, not a fragment', () => {
    expect(RedactedUrl.of('/p#')).toBe('/p#');
    expect(RedactedUrl.of('/p?a=1#')).toBe(`/p?a=${mark}#`);
    expect(RedactedUrl.of('/a%23b/c#secret')).toBe(`/a%23b/c#${mark}`);
    expect(RedactedUrl.of('/p?a=x%23y')).toBe(`/p?a=${mark}`);
  });

  it('a url that is only a fragment, a `#` inside a query value, and malformed shapes: never the content', () => {
    // A client error report can name a `location.href` that is all fragment; a `#` after a query
    // value ends that value (the first `#` rule) rather than riding inside it; and shapes no
    // browser would send still come back with nothing but marks and separators.
    expect(RedactedUrl.of('#access=secret')).toBe(`#${mark}`);
    expect(RedactedUrl.of('/p?a=x#y')).toBe(`/p?a=${mark}#${mark}`);
    expect(RedactedUrl.of('##')).toBe(`#${mark}`);
    expect(RedactedUrl.of('#?token=secret')).toBe(`#${mark}`);
    expect(RedactedUrl.of('?#')).toBe('?#');
    expect(RedactedUrl.of('')).toBe('');
  });

  it('a token-shaped fragment — an OAuth implicit response, a bare hex token, padded base64 — is the one mark', () => {
    // The fragment is where a client-side credential rides BY DESIGN (an OAuth implicit-flow
    // response lands its access token there so no server receives it; an invite link's bare
    // token likewise): whatever shape the token takes, and however many `&`-joined pieces ride
    // beside it, the mark is all that prints — with or without a query in front.
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c0ffee';
    expect(RedactedUrl.of(`/callback#access_token=${jwt}&token_type=bearer&expires_in=3600&state=s1`)).toBe(
      `/callback#${mark}`
    );
    expect(RedactedUrl.of('/invite#deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBe(
      `/invite#${mark}`
    );
    expect(RedactedUrl.of('/p#dG9rZW4vc2VjcmV0==')).toBe(`/p#${mark}`);
    expect(RedactedUrl.of(`/p?id=7#access_token=${jwt}`)).toBe(`/p?id=${mark}#${mark}`);
  });

  it('a very long query costs linear time and redacts every piece', () => {
    const pieces = 100_000;
    const query = Array.from({ length: pieces }, (_, i) => `k${i}=v${i}`).join('&');
    const started = Date.now();
    const redacted = RedactedUrl.of(`/p?${query}`);
    const elapsedMs = Date.now() - started;
    expect(redacted.split(mark).length - 1).toBe(pieces);
    expect(redacted).not.toContain('=v');
    // Linear work over 100k pieces is milliseconds; anything quadratic is minutes.
    expect(elapsedMs).toBeLessThan(2000);
  });
});
