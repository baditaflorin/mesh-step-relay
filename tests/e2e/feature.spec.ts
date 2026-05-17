import { expect, test } from "@playwright/test";
import { openTwoPeers } from "@baditaflorin/mesh-common/testing";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  name: string;
};
const storagePrefix = pkg.name;

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
