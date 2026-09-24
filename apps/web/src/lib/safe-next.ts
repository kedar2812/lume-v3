/** A plain in-app path: a slash, then letters, digits, hyphens, underscores and slashes — but not "//". */
const IN_APP = new RegExp("^/(?![/\\\\])[A-Za-z0-9_/-]*$");

/**
 * Where to go after signing in. Only a plain in-app path is allowed, so a crafted ?next= can never send
 * someone off-site: not a full URL, and not "//host" or "/\host", which browsers read as another server.
 */
export function safeNext(next: string | undefined): string {
  return next && IN_APP.test(next) ? next : "/today";
}
