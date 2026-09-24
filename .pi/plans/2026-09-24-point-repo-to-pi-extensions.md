# Point this checkout to `rigerc/pi-extensions`

## Goal

Make `https://github.com/rigerc/pi-extensions` the GitHub home and `origin` for this monorepo, while keeping the existing local work and package identity `@rigerc/pi-system-one`.

## Current state (2026-09-24)

- `origin` fetches and pushes `https://github.com/rigerc/pi-skillshare.git`.
- GitHub reports `rigerc/pi-skillshare` as a standalone repository (not a GitHub fork). The requested `rigerc/pi-extensions` repository does not currently resolve.
- Local `master` is 13 commits ahead of and 2 commits behind the old `origin/master`. The working tree contains staged and unstaged changes for the `pi-jev` to `pi-system-one` move, plus untracked plans. Do not pull, reset, or overwrite this work as part of changing remotes.
- The package's `repository`, `bugs`, and `homepage` fields and its Git install example currently point at `rigerc/pi-system-one`, which also differs from the intended monorepo URL. Runtime `HTTP-Referer` and its test use that URL too.
- Release workflows target `master` and use npm trusted publishing. The repository association for the npm package must be updated before a publish from the new GitHub repository.

## Plan

1. **Preserve the current work.** Record `git status`, current `HEAD`, and the old remote URL. Finish or checkpoint the ongoing package rename in a commit before publishing the new repository; keep unrelated uncommitted changes intact. Review the 2 commits on the old remote that are absent locally and explicitly decide whether any belong in the monorepo. Never merge them just to remove the ahead/behind warning.
2. **Create the destination.** Create a new, empty `rigerc/pi-extensions` GitHub repository with no generated README, license, or `.gitignore`. Use an independent repository so `pi-skillshare` remains available at its current URL. Set `master` as the default branch after the first push. If a private repository is intended, choose that visibility here; the release workflow and public npm provenance assume a public repository.
3. **Repin Git safely.** Rename the current `origin` remote to `pi-skillshare` for traceability, add `https://github.com/rigerc/pi-extensions.git` as the new `origin`, and verify fetch and push URLs. Push the finalized local `master` to the empty destination with `git push -u origin master`; do not force push. This preserves local commit history. Review whether any old remote topic branches or tags actually belong in this monorepo before copying them.
4. **Update live links.** Change `packages/pi-system-one/package.json` `repository.url`, `bugs.url`, and `homepage` to the monorepo URL; add `directory: "packages/pi-system-one"` to its repository metadata. Change the README's Git install example to the new repository only after confirming Pi can install the package from that monorepo path; otherwise prefer the existing npm install example. Change the runtime `HTTP-Referer` and its test if that URL is meant to identify this repository. Leave historical plans and changelog entries as historical records.
5. **Review release ownership.** Verify GitHub Actions permissions and release-please behavior on the new repository. Configure npm trusted publisher for `rigerc/pi-extensions` and the relevant workflow filename before any publish attempt; the existing association with another repository will not authorize this workflow. Review branch protection and Dependabot settings in the new repository.
6. **Verify and cut over.** Run `npm run check`, `npm run test`, and `npm run publish:dry`. Confirm `git remote -v`, `git branch -vv`, GitHub's default branch, package metadata, and all live install links resolve to the new repository. Only then use the new repository for releases and tell consumers the canonical URL.

## Completion criteria

- `origin/master` tracks `rigerc/pi-extensions` and the working tree retains all intended monorepo changes.
- No live package metadata, install instructions, or runtime repository identifier points to `rigerc/pi-skillshare` or the nonexistent standalone `rigerc/pi-system-one` repository.
- Checks pass, and GitHub Actions plus npm trusted publishing are configured for the new repository before the first release.

## Decision to confirm before execution

This plan assumes the target is a **new, independent** repository under the existing `rigerc` account and that local Git history should be retained. If the desired destination is a different owner, an existing private repository, or a clean history, adjust steps 2–3 before creating or pushing anything.
