import type { Metadata } from "next";

import { shellCopy } from "@/lib/copy/shell";

import "./globals.css";

export const metadata: Metadata = {
  title: shellCopy.appName,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
