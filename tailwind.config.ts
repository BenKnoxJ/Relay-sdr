import type { Config } from "tailwindcss";

// Phase 1 Task 1 ships the plumbing only. The design system (master doc §21)
// lands with the token task; nothing here is a design decision.
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
