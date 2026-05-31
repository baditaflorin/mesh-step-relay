import { expect, test, type Page } from "@playwright/test";
import { openTwoPeers } from "@baditaflorin/mesh-common/testing";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  name: string;
};
const storagePrefix = pkg.name;

// Drive `n` real steps through the accelerometer path: useStepCount counts one
// step each time the smoothed magnitude crosses its 1.5 threshold upward with
// ≥ minStepMs (280ms) since the last step. So each "step" is a high-magnitude
// burst (cross up) followed by a low-magnitude burst (settle back below), the
// pair ≥ 280ms apart. This is the headless-Chromium stand-in for a phone being
// physically jostled — no real sensor hardware is readable in CI.
async function driveSensorSteps(page: Page, n: number) {
  for (let s = 0; s < n; s++) {
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => {
        window.dispatchEvent(
          new DeviceMotionEvent("devicemotion", {
            accelerationIncludingGravity: { x: 13.5, y: 0, z: 0 },
          } as unknown as DeviceMotionEventInit),
        );
      });
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(160);
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => {
        window.dispatchEvent(
          new DeviceMotionEvent("devicemotion", {
            accelerationIncludingGravity: { x: 9.81, y: 0, z: 0 },
          } as unknown as DeviceMotionEventInit),
        );
      });
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(160);
  }
}

test("alice claims baton + adds steps → bob sees count sync", async ({ browser, baseURL }) => {
  const { a, b, cleanup } = await openTwoPeers(browser, baseURL ?? "", { storagePrefix });
  try {
    await a.getByPlaceholder("your name").fill("alice");
    await b.getByPlaceholder("your name").fill("bob");
    await a.waitForTimeout(500);

    await a.getByRole("button", { name: "CLAIM BATON", exact: true }).click();
    await a.waitForTimeout(300);
    for (let i = 0; i < 5; i++) {
      await a.getByRole("button", { name: "+1 step", exact: true }).click();
    }
    await b.waitForTimeout(400);

    await expect(b.locator('.relay-steps[data-peer-name="alice"]')).toContainText("5");
  } finally {
    await cleanup();
  }
});

// THE load-bearing cross-peer assertion. Proves the advertised behaviour:
// the baton holder accumulates steps from the *accelerometer*, and reaching
// the target N auto-passes the baton to the *next peer* — on BOTH screens.
// A regression that broke sensor→count propagation, or that left the baton
// stuck on the finisher (the pre-fix behaviour — reach-N only enabled a manual
// PASS button, never advanced), fails this test.
test("alice's synthetic steps drive the baton, and reaching the target hands it to bob on both screens", async ({
  browser,
  baseURL,
}) => {
  const { a, b, cleanup } = await openTwoPeers(browser, baseURL ?? "", { storagePrefix });
  try {
    await a.getByPlaceholder("your name").fill("alice");
    await b.getByPlaceholder("your name").fill("bob");
    // Let both peers heartbeat into the roster so "next peer" is well-defined.
    await a.waitForTimeout(800);

    // alice starts the relay.
    await a.getByRole("button", { name: "CLAIM BATON", exact: true }).click();
    await a.waitForTimeout(300);
    await expect(a.locator(".relay-banner-name")).toHaveText("alice");
    await expect(b.locator(".relay-banner-name")).toHaveText("alice");

    // alice "walks": real synthetic accelerometer steps. Each crossing counts
    // one step in useStepCount and is published into the shared steps Y.Map.
    await a.getByRole("button", { name: /tap to enable step counter/i }).click();
    await driveSensorSteps(a, 4);

    // The sensor-derived count crossed the mesh: bob's alice row reflects it,
    // proving motion → count → peer propagation (not just a local UI tick).
    await b.waitForTimeout(500);
    const aliceRowB = b.locator('.relay-steps[data-peer-name="alice"]');
    const countAtB = Number((await aliceRowB.getAttribute("data-count")) ?? "0");
    expect(countAtB).toBeGreaterThanOrEqual(4);

    // Top alice up to the target with the testable +1 fallback (same publish
    // path) so we reach N quickly rather than driving 25 sensor crossings.
    const target = Number(await a.evaluate(() => 25)); // DEFAULT_TARGET
    const myLabel = a.locator(".relay-step-label");
    let guard = 0;
    while (
      Number((await myLabel.textContent())?.split("/")[0]?.trim() ?? "0") < target &&
      guard < 60
    ) {
      await a.getByRole("button", { name: "+1 step", exact: true }).click();
      guard++;
    }

    // Reaching N auto-passes: the baton must leave alice and land on bob, and
    // BOTH screens must agree on the new holder (the relay handed off).
    await expect(b.locator(".relay-banner-name")).toHaveText("bob", { timeout: 8000 });
    await expect(a.locator(".relay-banner-name")).toHaveText("bob", { timeout: 8000 });
  } finally {
    await cleanup();
  }
});
