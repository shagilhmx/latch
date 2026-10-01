/**
 * Repository-path normalization shared by the Coordinator, the UI, and the
 * agent/session tooling. Leases are keyed by the normalized form, so every
 * side must agree exactly.
 */
export class InvalidPathError extends Error {
  constructor(input: string) {
    super(`Invalid repository path: ${JSON.stringify(input)}`);
    this.name = "InvalidPathError";
  }
}

export function normalizePath(input: string): string {
  let path = input.trim().replaceAll("\\", "/");

  while (path.startsWith("./")) {
    path = path.slice(2);
  }
  while (path.startsWith("/")) {
    path = path.slice(1);
  }

  if (path.length === 0 || path.includes("//")) {
    throw new InvalidPathError(input);
  }

  // Directory claims (e.g. `src/`) claim a whole subtree; they are stored
  // with the trailing slash so every consumer agrees on the form.
  const isDirectory = path.endsWith("/");
  if (isDirectory) {
    path = path.slice(0, -1);
  }

  if (path.length === 0) {
    throw new InvalidPathError(input);
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment === "")) {
    throw new InvalidPathError(input);
  }

  return isDirectory ? `${path}/` : path;
}

/** Normalizes, de-duplicates, and sorts a list of repository paths. */
export function normalizePaths(inputs: readonly string[]): string[] {
  const unique = new Set(inputs.map((input) => normalizePath(input)));
  return [...unique].sort();
}

/** True when `path` lives inside directory `prefix` (or is the directory itself). */
export function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** True when a lease entry is a directory claim (stored with trailing `/`). */
export function isDirectoryLease(path: string): boolean {
  return path.endsWith("/");
}

/**
 * True when `lease` covers `path`: exact match for file leases, subtree
 * membership for directory leases (`src/` covers `src/a/b.ts`).
 */
export function leaseCovers(lease: string, path: string): boolean {
  return isDirectoryLease(lease) ? path.startsWith(lease) : path === lease;
}

/** True when two leases claim overlapping scope (conflict if by different agents). */
export function leasesOverlap(a: string, b: string): boolean {
  const dirA = isDirectoryLease(a);
  const dirB = isDirectoryLease(b);
  if (dirA && dirB) return a.startsWith(b) || b.startsWith(a);
  if (dirA) return b.startsWith(a);
  if (dirB) return a.startsWith(b);
  return a === b;
}
