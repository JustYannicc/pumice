# Changesets

Add one Changeset for each user-facing package change. Run `pnpm changeset`, choose `pumice`, select the bump level, and describe the change in plain language. Commit the generated Markdown file with the code change.

- `patch` fixes behavior without changing the public API.
- `minor` adds backwards-compatible public behavior.
- `major` breaks or removes public behavior.

On `main`, Changesets opens or updates a version pull request. Merging that pull request publishes the new package version through npm trusted publishing. The first publication needs the npm package and its trusted publisher configured before the release workflow can publish.
