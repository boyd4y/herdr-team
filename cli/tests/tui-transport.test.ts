import { expect, test } from "bun:test";
import { tuiSubscriptionPath } from "../scripts/lib/runtime/daemon-binding.ts";

test("raw Windows subscriptions use the Herdr marker's literal pipe name", () => {
  const marker = "D:\\Roaming Profile\\herdr\\sessions\\work\\herdr.sock";
  expect(tuiSubscriptionPath(marker, "win32")).toBe("\\\\.\\pipe\\" + marker);
  expect(tuiSubscriptionPath("/tmp/herdr.sock", "darwin")).toBe("/tmp/herdr.sock");
});
