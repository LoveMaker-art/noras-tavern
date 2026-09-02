#!/bin/sh
set -eu

UPSTREAM_URL=https://github.com/MagicalAstrogy/MagVarUpdate.git
UPSTREAM_COMMIT=7fe9ae7cfe01f13d606f7a2e533a458431fe318c
RUNNER_URL=https://github.com/N0VI028/JS-Slash-Runner.git
RUNNER_COMMIT=c1d0953bf1a5ca4ff28eea513fc1362eef81b80c
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/nora-mvu-build.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT INT TERM

download_commit() {
    repository_url=$1
    commit=$2
    destination=$3
    archive="$WORK_DIR/$(basename "$destination").tar.gz"

    curl --fail --location --retry 3 \
        "${repository_url%.git}/archive/${commit}.tar.gz" \
        --output "$archive"
    mkdir -p "$destination"
    tar -xzf "$archive" --strip-components=1 -C "$destination"
    git -C "$destination" init --quiet
}

# Git's recursive submodule clone can wait indefinitely on a slow GitHub
# connection. Fetch only the pinned main commit so the build can still embed
# its real revision, then download the pinned runner independently.
git init --quiet "$WORK_DIR/source"
git -C "$WORK_DIR/source" remote add origin "$UPSTREAM_URL"
git -C "$WORK_DIR/source" fetch --quiet --depth 1 origin "$UPSTREAM_COMMIT"
git -C "$WORK_DIR/source" checkout --quiet --detach FETCH_HEAD
rm -rf "$WORK_DIR/source/slash-runner"
download_commit "$RUNNER_URL" "$RUNNER_COMMIT" "$WORK_DIR/source/slash-runner"
git -C "$WORK_DIR/source" apply --recount "$SCRIPT_DIR/upstream/nora.patch"
git -C "$WORK_DIR/source/slash-runner" apply --recount "$SCRIPT_DIR/upstream/slash-runner.patch"

(
    cd "$WORK_DIR/source"
    npx --yes corepack@0.32.0 yarn install --immutable
    NORA_BUNDLE_DEPENDENCIES=1 npx --yes corepack@0.32.0 yarn build
)

cp "$WORK_DIR/source/artifact/bundle.js" "$SCRIPT_DIR/vendor/bundle.js"
# webpack emits references to these two companions. Preserve the license and
# strip the source-map directive because production releases do not ship source
# maps for the vendored runtime.
cp "$WORK_DIR/source/artifact/bundle.js.LICENSE.txt" "$SCRIPT_DIR/vendor/bundle.js.LICENSE.txt"
sed -i.bak '/^\/\/# sourceMappingURL=bundle\.js\.map$/d' "$SCRIPT_DIR/vendor/bundle.js"
rm "$SCRIPT_DIR/vendor/bundle.js.bak"
node --check "$SCRIPT_DIR/vendor/bundle.js"
shasum -a 256 "$SCRIPT_DIR/vendor/bundle.js"
