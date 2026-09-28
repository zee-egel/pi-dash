import { randomBytes, scryptSync } from "node:crypto";
// Read stdin; never put the password in command arguments or shell history.
let password = "";
for await (const chunk of process.stdin) password += chunk;
password = password.replace(/\r?\n$/, "");
if (password.length < 8) {
  console.error("Use a password of at least 8 characters (provided on stdin).");
  process.exit(1);
}
const salt = randomBytes(16).toString("hex");
console.log(
  `scrypt:${salt}:${scryptSync(password, salt, 64, { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }).toString("hex")}`,
);
