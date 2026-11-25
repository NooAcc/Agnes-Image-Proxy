import assert from "node:assert/strict";
import test from "node:test";
import { loadGalleryCardImage } from "../web/gallery.ts";

function imageHarness() {
  const assigned = [];
  return { assigned, image: { set src(value) { assigned.push(value); }, onerror: null } };
}

test("cards use public thumbnail URLs and fall back once to the original", () => {
  const { image, assigned } = imageHarness();
  const failures = {};
  let errors = 0;
  const item = { imageUrl: "/images/random/original.jpg", thumbnailUrl: "/images/random/thumb-version.webp" };
  loadGalleryCardImage(item, image, failures, () => errors++);
  assert.deepEqual(assigned, [item.thumbnailUrl]);
  image.onerror();
  assert.deepEqual(assigned, [item.thumbnailUrl, item.imageUrl]);
  image.onerror();
  assert.equal(errors, 1);
  assert.equal(image.onerror, null);
  loadGalleryCardImage(item, image, failures, () => errors++);
  assert.equal(assigned.length, 2);
  assert.equal(errors, 2);
});

test("missing thumbnails use direct HTTPS originals without a blob or proxy request", () => {
  const { image, assigned } = imageHarness();
  loadGalleryCardImage({ imageUrl: "https://img.example/file/random.png", thumbnailUrl: null }, image, {}, () => assert.fail());
  assert.deepEqual(assigned, ["https://img.example/file/random.png"]);
});

test("missing originals show an unavailable placeholder without image requests", () => {
  const { image, assigned } = imageHarness();
  let errors = 0;
  loadGalleryCardImage({ imageUrl: null, thumbnailUrl: null }, image, {}, () => errors++);
  assert.equal(errors, 1);
  assert.deepEqual(assigned, []);
});

test("same original and thumbnail URL is not retried and new versions remain loadable", () => {
  const failures = {};
  const { image, assigned } = imageHarness();
  let errors = 0;
  loadGalleryCardImage({ imageUrl: "/images/a.png", thumbnailUrl: "/images/a.png" }, image, failures, () => errors++);
  image.onerror();
  assert.deepEqual(assigned, ["/images/a.png"]);
  assert.equal(errors, 1);
  loadGalleryCardImage({ imageUrl: "/images/a.png", thumbnailUrl: "/images/new.png" }, image, failures, () => errors++);
  assert.deepEqual(assigned, ["/images/a.png", "/images/new.png"]);
});
