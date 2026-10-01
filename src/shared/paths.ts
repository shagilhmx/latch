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

  if (path.length === 0 || path.endsWith("/") || path.includes("//")) {
    throw new InvalidPathError(input);
  }

  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment === "")) {
    throw new InvalidPathError(input);
  }

  return path;
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
