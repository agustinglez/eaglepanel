/**
 * WordPress scan process. The agent launches it as the account user (`setpriv`), with HOME set to its home
 * directory: it reads only what that user can read and never runs as root.
 *
 *   wordpress-worker.ts   JSON list of sites on stdin, JSON list of installations on stdout
 *
 * An error exits with code 1 and the message on stderr.
 */
import { wordpressOps } from "@eaglepanel/shared";
import { scanAccount } from "./wordpress";

if (process.getuid?.() === 0) {
  process.stderr.write("The WordPress scan does not run as root");
  process.exit(1);
}

try {
  const sites = wordpressOps["wordpress.scan"].params.shape.sites.parse(JSON.parse(await Bun.stdin.text()));
  process.stdout.write(JSON.stringify(await scanAccount(process.env.HOME ?? "", sites)));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
