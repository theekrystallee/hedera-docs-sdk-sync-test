# SDK docs sync

The [SDK Docs Sync](../workflows/sdk-docs-sync.yml) workflow keeps the native SDK docs in step with the [hiero-ledger SDK repos](https://github.com/orgs/hiero-ledger/repositories?q=sdk). It runs daily at 08:00 UTC and on demand (**Actions → SDK Docs Sync → Run workflow**).

Each `<sdk>.json` file here records the SDK version the docs were last reviewed against, along with the package name seen at that version. Merging a sync PR moves that version forward.

## What a run does

For each SDK (`js`, `java`, `go`, `python`, `swift`, `rust`, `cpp`), when the latest stable release is newer than the recorded version:

1. **Bumps install pins** in the docs (Gradle/Maven coordinates, `package.json` snippets, and so on) to the latest version. Only explicit install snippets are bumped. "Available in vX.Y.Z+" feature minimums are never touched.
2. **Diffs the public API** between the two tags using the SDK source trees, not the changelog. It looks for new and removed `*Transaction`/`*Query` classes and for public methods added to or removed from existing classes. Each change is checked against the docs, and items that aren't documented are flagged.
3. **Flags breaking changes and deprecations** from the release notes of every release in between.
4. **Flags a package rename upstream**, plus retired identifiers that are still in the docs (such as `@hashgraph/sdk`). These are reported only, never auto-replaced.

The result is one PR per SDK on `automation/sdk-sync-<sdk>`. The PR body is a checklist report. Content changes, such as documenting a new class or method, are pushed to that branch by a reviewer.

Once a reviewer has pushed commits to a sync branch, the workflow stops refreshing that PR so it doesn't overwrite their work. Merge or close the PR to resume.

## Common tasks

- **Re-report older changes:** run the workflow with a single SDK and set `from` (for example `2.76.0`).
- **Run locally:** `GH_TOKEN=$(gh auth token) node .github/scripts/sdk-sync.js --sdk java`. This edits the docs and the state file in place, so run it on a scratch branch.
- **Add a pin pattern, retired identifier, or new SDK:** edit [`sdk-sources.js`](../scripts/lib/sdk-sources.js), add a `<sdk>.json` state file, and add the SDK to the workflow matrix and the `sdk` input options.
