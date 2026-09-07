import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomePage from "@/app/page";
import { shellCopy } from "@/lib/copy/shell";

describe("home page", () => {
  it("renders its text from the copy file", () => {
    render(<HomePage />);
    expect(screen.getByText(shellCopy.placeholder)).toBeDefined();
  });
});
