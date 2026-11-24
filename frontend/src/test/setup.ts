import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { installMatchMedia } from "./match-media";

installMatchMedia();

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.className = "";
});
