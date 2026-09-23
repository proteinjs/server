import { RedactedUrl } from '../src/RedactedUrl';

/**
 * The redacted form's edges, on the class itself (the request logging suite proves the lines that
 * print it; this suite pins the form on the shapes a real url can take). The rule under test: the
 * path exactly as it came, then `?`, then every query piece as `key=<redacted>` — the key printed
 * verbatim (never decoded, never re-encoded, never merged with a repeat), the value gone whatever
 * it held, however it was encoded, and however many pieces there are.
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
