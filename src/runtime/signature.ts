/**
 * The CMS's signature on a webhook body: X-CMS-Signature: sha256=<hex
 * HMAC-SHA256 of the body with the shared secret>, compared in constant time.
 * Web Crypto only, so it runs on Workers.
 */
export async function verify(body: string, header: string | null, secret: string): Promise<boolean> {
  const given = header?.startsWith("sha256=") ? header.slice(7) : null;
  if (!given) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const expected = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (expected.length !== given.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return difference === 0;
}
