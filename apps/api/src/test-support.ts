import { slugify, type AccountLimits } from "@eaglepanel/shared";

type RunJob = (path: string, body: unknown) => Promise<{ status: string }>;

/** For tests: the slug an environment gets from its domain, `example.com` -> `examplecom`. */
export const testSlug = (fqdn: string) => slugify(fqdn);

/**
 * For tests: an account with a domain and an environment for it, named after the domain. Stops at the first job that
 * does not succeed and returns it.
 */
export async function createSiteAccount(run: RunJob, { username, domain, phpVersion = "85", limits }: { username: string; domain: string; phpVersion?: string; limits: AccountLimits }) {
  const steps: [string, unknown][] = [
    ["/accounts", { username, limits }],
    [`/accounts/${username}/domains`, { domain }],
    [`/accounts/${username}/vhosts`, { name: domain, slug: testSlug(domain), hostname: domain, phpVersion }],
  ];
  let job = { status: "succeeded" };
  for (const [path, body] of steps) {
    job = await run(path, body);
    if (job.status !== "succeeded") return job;
  }
  return job;
}

/** For tests: a subdomain of an account domain and an environment for it, named after it. */
export async function addEnvironment(run: RunJob, username: string, fqdn: string) {
  const host = await run(`/accounts/${username}/hostnames`, { fqdn });
  if (host.status !== "succeeded") return host;
  return run(`/accounts/${username}/vhosts`, { name: fqdn, slug: testSlug(fqdn), hostname: fqdn, phpVersion: "85" });
}
