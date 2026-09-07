process.env.INTEGRATIONS = "mock";

// `??=` would leave an empty string in place, and the guard below would then
// die on URL parsing instead of saying what is wrong.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://relay:relay@127.0.0.1:5435/relay_test";
}
if (!process.env.DIRECT_URL) {
  process.env.DIRECT_URL = process.env.DATABASE_URL;
}

// The suite truncates. Pointing it at the development database — or at
// anything in production — would destroy real work, so refuse to start unless
// the target database is explicitly a test one.
let target: string;
try {
  target = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, "");
} catch {
  throw new Error(
    `Refusing to run tests: DATABASE_URL is not a valid connection string (${JSON.stringify(process.env.DATABASE_URL)}).`,
  );
}
if (!target.endsWith("_test")) {
  throw new Error(
    `Refusing to run tests against database "${target}": DATABASE_URL must point at a database whose name ends in "_test".`,
  );
}
