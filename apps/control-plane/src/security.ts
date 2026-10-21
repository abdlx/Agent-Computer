/** Browser Origin checks. Non-browser clients may omit Origin and still require credentials. */
export function originAllowed(origin: string | undefined, host: string | undefined, secure: boolean, publicOrigin?: string): boolean {
  if (origin === undefined) return true;
  if (!host || origin === "null") return false;
  try {
    const expected = new URL(publicOrigin || `${secure ? "https" : "http"}://${host}`);
    const supplied = new URL(origin);
    return supplied.origin === expected.origin && supplied.pathname === "/" && !supplied.search && !supplied.hash && !supplied.username && !supplied.password;
  } catch { return false; }
}
