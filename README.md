# Pumice

Pumice prepares and verifies immutable runtime artifacts, and tracks which verified release is selected for each provider.

The package separates portable verification from Node.js filesystem and publication helpers:

- `pumice/artifacts` opens an artifact through a byte-reading source and verifies its manifest and file hashes.
- `pumice/artifacts/node` prepares artifacts from local provider directories and publishes their files to a storage adapter.
- `pumice/releases` provides a transactional ledger for artifacts, verification proofs, and release selection.

Install Pumice and its Effect peer dependency:

```sh
pnpm add pumice effect@4.0.5
```

The portable artifact reader is suitable for runtimes that can provide Web Crypto and a storage-backed `read` function. The preparation and publication helpers require Node.js. See the exported TypeScript types for the exact input and storage contracts.

## Releases

Changesets creates a version pull request on `main`; merging it publishes the package with npm provenance. Automated publishing uses npm trusted publishing with the GitHub Actions `npm` environment. npm requires the package to exist before trusted publishing can be configured, so the initial package bootstrap must happen first. After that setup, run the release workflow manually on `main` to publish the current version, or let the normal Changesets flow publish later versions.
