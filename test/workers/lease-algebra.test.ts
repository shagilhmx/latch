import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  leaseCovers,
  leasesOverlap,
  normalizePath,
  normalizePaths,
} from "../../src/shared/paths.ts";
import { workspaceApi } from "./helpers";

/**
 * Property-based tests for the lease algebra — the invariant Latch sells:
 * at no interleaving of claims and releases do two changesets ever hold
 * overlapping scope, and every claim is all-or-nothing.
 *
 * Two layers:
 *  1. pure properties over src/shared/paths (fast, thousands of runs);
 *  2. a model-free HTTP property: two agents interleaving random claims and
 *     releases against the real Coordinator, re-checked after every op.
 */

const POOL = ["src/", "src/auth.ts", "src/api/", "src/api/routes.ts", "lib/util.ts", "README.md", "docs/"];

/** Raw input forms that must all normalize to the same canonical paths. */
const RAW = ["./src/auth.ts", "src\\api\\routes.ts", "/README.md", "src/", "./src/api/", "lib/util.ts"];

interface LeaseView {
  path: string;
  changeset: string;
}

function heldBy(leases: LeaseView[], changeset: string): string[] {
  return leases
    .filter((lease) => lease.changeset === changeset)
    .map((lease) => lease.path)
    .sort();
}

/** Core invariant: leases held by different changesets never overlap. */
function assertExclusive(leases: LeaseView[]): void {
  for (let i = 0; i < leases.length; i += 1) {
    for (let j = i + 1; j < leases.length; j += 1) {
      const a = leases[i];
      const b = leases[j];
      if (a === undefined || b === undefined || a.changeset === b.changeset) continue;
      expect(
        leasesOverlap(a.path, b.path),
        `${a.path} (${a.changeset}) overlaps ${b.path} (${b.changeset})`,
      ).toBe(false);
    }
  }
}

describe("lease algebra (pure properties)", () => {
  it("overlap is reflexive and symmetric", () => {
    fc.assert(
      fc.property(fc.constantFrom(...POOL), fc.constantFrom(...POOL), (a, b) => {
        expect(leasesOverlap(a, a)).toBe(true);
        expect(leasesOverlap(a, b)).toBe(leasesOverlap(b, a));
      }),
      { numRuns: 500 },
    );
  });

  it("directory leases cover exactly their subtree", () => {
    fc.assert(
      fc.property(fc.constantFrom("src/", "src/api/", "lib/"), fc.constantFrom(...POOL), (dir, path) => {
        expect(leaseCovers(dir, path)).toBe(path.startsWith(dir));
      }),
      { numRuns: 500 },
    );
  });

  it("normalization is idempotent and order-independent", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...RAW), { minLength: 1, maxLength: 8 }), (paths) => {
        const once = normalizePaths(paths);
        expect(normalizePaths(once)).toEqual(once);
        expect(normalizePaths([...paths].reverse())).toEqual(once);
        expect(once.every((path) => path === normalizePath(path))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe("lease algebra (against the Coordinator)", () => {
  const arbPaths = fc.uniqueArray(fc.constantFrom(...POOL), { minLength: 1, maxLength: 3 });
  const arbProgram = fc.array(
    fc.record({
      action: fc.constantFrom("claim" as const, "release" as const),
      who: fc.constantFrom(0, 1),
      paths: arbPaths,
    }),
    { minLength: 1, maxLength: 6 },
  );

  it("keeps leases exclusive and claims all-or-nothing under any interleaving", async () => {
    await fc.assert(
      fc.asyncProperty(arbProgram, async (program) => {
        const w = workspaceApi();
        const ids = [
          await w.createChangeset("agent-a", "property A"),
          await w.createChangeset("agent-b", "property B"),
        ];

        for (const op of program) {
          const changeset = ids[op.who];
          if (changeset === undefined) continue;

          const before = await w.get<{ leases: LeaseView[] }>("/");
          const response =
            op.action === "claim"
              ? await w.post<any>(`/changesets/${changeset}/leases`, {
                  paths: op.paths,
                  ttlSeconds: 60,
                })
              : await w.del<any>(`/changesets/${changeset}/leases`, { paths: op.paths });
          const after = await w.get<{ leases: LeaseView[] }>("/");

          // Invariant 1: cross-changeset exclusivity holds after every op.
          assertExclusive(after.body.leases);

          if (op.action !== "claim") continue;
          const expected = normalizePaths(op.paths);

          if (response.status === 200) {
            // Success grants exactly the requested (normalized) paths…
            expect(response.body.granted).toEqual(expected);
            // …and this changeset now owns each of them.
            for (const path of expected) {
              const lease = after.body.leases.find((entry) => entry.path === path);
              expect(lease?.changeset).toBe(changeset);
            }
          } else {
            // Invariant 2: failure is all-or-nothing — nothing was taken.
            expect(response.status).toBe(409);
            expect(response.body.error).toBe("lease_conflict");
            expect(heldBy(after.body.leases, changeset)).toEqual(
              heldBy(before.body.leases, changeset),
            );
            // Invariant 3: every reported conflict is a live lease held by
            // another changeset that actually overlaps a requested path.
            for (const conflict of response.body.conflicts as Array<{
              path: string;
              changeset: string;
            }>) {
              const live = after.body.leases.find((entry) => entry.path === conflict.path);
              expect(live?.changeset).toBe(conflict.changeset);
              expect(
                op.paths.some((path) => leasesOverlap(normalizePath(path), conflict.path)),
              ).toBe(true);
            }
          }
        }
      }),
      { numRuns: 15 },
    );
  }, 120_000);
});
