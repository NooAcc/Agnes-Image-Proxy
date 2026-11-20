import { assertEquals } from "@std/assert";
import { imageModelList } from "../../lib/model-catalog.ts";

Deno.test("catalog exposes the two tier image models", () => {
  assertEquals(imageModelList(), [
    "agnes-image-2.5-flash",
    "agnes-image-2.1-flash",
  ]);
});
