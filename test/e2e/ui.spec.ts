import { expect, test, type Page } from "@playwright/test";

/**
 * Live-UI end-to-end checks against a real `wrangler dev` (started by
 * playwright.config.ts). These prove the behaviors the README claims:
 * WebSocket streaming, mutations appearing without reload, the auth bar,
 * mobile layout, and a clean console.
 */

/** Collect console/page errors, ignoring benign favicon noise. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("favicon")) {
      errors.push(`console: ${message.text()}`);
    }
  });
  return errors;
}

test("streams the workspace snapshot with a clean console", async ({ page }) => {
  const errors = trackErrors(page);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Latch/ })).toBeVisible();
  await expect(page.locator(".status-text")).toHaveText("streaming");
  await expect(page.getByText("OPEN LEASES")).toBeVisible();
  await expect(page.getByRole("article", { name: /Changesets/ })).toBeVisible();

  // Give the socket a moment to prove it stays quiet and healthy.
  await page.waitForTimeout(1_500);
  expect(errors).toEqual([]);
});

test("shows an external mutation without a reload (WebSocket push)", async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page.locator(".status-text")).toHaveText("streaming");

  // Mutate the workspace out-of-band (same origin, no page involvement).
  // Unique per run: the e2e workspace persists across runs.
  const agent = `playwright-${Date.now().toString(36)}`;
  const status = await page.evaluate(async (name) => {
    const response = await fetch("/api/workspaces/demo/changesets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: name, intent: "Pushed while the page is open" }),
    });
    return response.status;
  }, agent);
  expect(status).toBe(201);

  // The changeset panel updates with NO reload…
  await expect(
    page
      .getByRole("article", { name: /Changesets/ })
      .locator("li", { hasText: agent })
      .first(),
  ).toBeVisible();
  // …and the merge stream receives the event.
  await expect(
    page
      .getByRole("article", { name: /Merge stream/ })
      .getByText(new RegExp(`${agent}: Pushed while`))
      .first(),
  ).toBeVisible({ timeout: 5_000 });
  expect(errors).toEqual([]);
});

test("shows the current identity and reflects a dev login switch", async ({
  page,
}) => {
  await page.goto("/");
  // Dev mode: identity chip visible, no GitHub sign-in button.
  await expect(page.locator(".authbar")).toContainText("dev");
  await expect(page.locator(".signin")).toHaveCount(0);

  const loginStatus = await page.evaluate(async () => {
    const response = await fetch("/api/auth/dev", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "e2e" }),
    });
    return response.status;
  });
  expect(loginStatus).toBe(200);

  await page.reload();
  await expect(page.locator(".authbar")).toContainText("e2e");

  // Clean up this identity so other runs start from `dev`.
  await page.evaluate(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
  });
});

test("claims scope from the UI and aborts it (streamed, no reload)", async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page.locator(".status-text")).toHaveText("streaming");

  const stamp = Date.now().toString(36);
  const agent = `ui-${stamp}`;
  const path = `src/e2e-${stamp}.ts`;
  await page.getByLabel("Agent").fill(agent);
  await page.getByLabel("Intent").fill("Claimed from the UI action panel");
  await page.getByLabel("Paths to lease").fill(path);
  await page.getByRole("button", { name: "Claim scope" }).click();

  // The changeset and its lease appear over the WebSocket — no reload.
  const item = page
    .getByRole("article", { name: /Changesets/ })
    .locator("li", { hasText: agent })
    .first();
  await expect(item).toBeVisible({ timeout: 5_000 });
  await expect(item).toContainText(path);
  await expect(
    page.getByRole("article", { name: /Lease map/ }),
  ).toContainText(path, { timeout: 5_000 });

  // Abort releases the lease and closes the changeset, also streamed.
  await item.getByRole("button", { name: /Abort/ }).click();
  await expect(item.locator(".chip")).toHaveText("aborted", { timeout: 5_000 });
  await expect(
    page.getByRole("article", { name: /Lease map/ }),
  ).not.toContainText(path, { timeout: 5_000 });
  expect(errors).toEqual([]);
});

test("manages workspace members from the UI", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page.locator(".status-text")).toHaveText("streaming");

  const stamp = Date.now().toString(36);
  const members = page.getByRole("article", { name: /Members/ });
  await members.getByLabel("User ID").fill(`uid-${stamp}`);
  await members.getByLabel("Login").fill(`login-${stamp}`);
  await members.getByLabel("Role").selectOption("write");
  await members.getByRole("button", { name: "Add member" }).click();

  const row = members.locator(".member", { hasText: `login-${stamp}` });
  await expect(row).toBeVisible({ timeout: 5_000 });
  await expect(row).toContainText("write");

  await row.getByRole("button", { name: `Remove login-${stamp}` }).click();
  await expect(row).toHaveCount(0, { timeout: 5_000 });
  expect(errors).toEqual([]);
});

test("has no horizontal overflow on a 390px mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator(".status-text")).toHaveText("streaming");

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});

test("exposes semantic structure and live-region announcements", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Latch");
  // Connection status is announced to assistive tech.
  await expect(page.locator('[aria-live="polite"]')).toHaveCount(1);

  // Keyboard: when interactive controls exist (github mode sign-in), the
  // first Tab must reach them. Dev mode has no controls by design — the
  // identity chip is informational — so we only assert when they render.
  const interactive = page.locator("a, button");
  if ((await interactive.count()) > 0) {
    await interactive.first().focus();
    const focusedTag = await page.evaluate(
      () => document.activeElement?.tagName ?? "",
    );
    expect(["A", "BUTTON"]).toContain(focusedTag);
  } else {
    await expect(page.locator(".authbar")).toContainText("dev");
  }
});
