import { shellCopy } from "@/lib/copy/shell";

export default function HomePage() {
  return (
    <main>
      <p>{shellCopy.placeholder}</p>
    </main>
  );
}
