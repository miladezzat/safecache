# Releasing to npm

SafeCache uses Changesets and GitHub Actions for npm releases.

## One-time npm setup

1. Create or confirm access to the `@safecache` npm scope.
2. Create an npm automation token with publish access.
3. Add the token to the GitHub repository as `NPM_TOKEN`.
4. Make sure every package intended for npm has a public package name and is not marked private.

The release workflow reads Node from `.nvmrc`, installs with pnpm, runs the full verification gate, and then runs Changesets.

## Release flow

1. Add a changeset:

   ```bash
   pnpm changeset
   ```

2. Commit and merge to `main`.
3. The `Release` workflow opens or updates a release PR named `chore: release packages`.
4. Merge the release PR.
5. The next `main` workflow run publishes changed packages to npm with:

   ```bash
   pnpm release
   ```

## Trusted Publishing

The workflow already grants `id-token: write` and sets `NPM_CONFIG_PROVENANCE=true`, which supports npm provenance when the publisher supports it.

For tokenless Trusted Publishing, configure each npm package under npm package settings to trust this GitHub repository and workflow:

```txt
Repository: miladezzat/safecache
Workflow: .github/workflows/release.yml
Environment: none
```

After that is configured and verified for every published package, remove `NPM_TOKEN` and `NODE_AUTH_TOKEN` from the workflow environment.
