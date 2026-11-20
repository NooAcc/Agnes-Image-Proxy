import { assertEquals } from "@std/assert";
import { imageModelList, sizeModeFor } from "../../lib/model-catalog.ts";

Deno.test("catalog exposes three image models and 2.0 is exact", () => {
  assertEquals(imageModelList().map((model) => model.id), [
    "agnes-image-2.5-flash",
    "agnes-image-2.1-flash",
    "agnes-image-2.0-flash",
  ]);
  assertEquals(sizeModeFor("agnes-image-2.0-flash"), "exact");
  assertEquals(sizeModeFor("agnes-image-2.5-flash"), "tier");
  assertEquals(sizeModeFor("unknown-model"), "tier");
});
