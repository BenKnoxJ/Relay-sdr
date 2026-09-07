import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// `globals` is off, so Testing Library's automatic cleanup never registers
// itself. Without this, a second render in the same file leaves the first one
// in the document and every query throws "found multiple elements".
afterEach(() => {
  cleanup();
});
