#!/usr/bin/env bash
# Copies the shared core (core/src/) into deploy/aws/_core/, fresh each time, so the worker
# image can hold it: its build context is deploy/aws/ and cannot reach core/. The copy is not
# committed (.gitignore). stand-up.sh and test/run.sh run this first; run it by hand before
# `npx tsc` or a docker build of your own.
#
#   bash deploy/aws/scripts/copy-core.sh
#
# The Lambdas do not need it: esbuild bundles core/src/ straight from the repository.
set -euo pipefail
pkg="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$(cd "$pkg/../../core/src" && pwd)"
rm -rf "$pkg/_core"
mkdir -p "$pkg/_core"
cp -R "$src/." "$pkg/_core/"
echo "copied core/src/ to deploy/aws/_core/"
# Session H's processing step (worker/src/) for the worker image, in _worker/ next to _core/.
worker_src="$(cd "$pkg/../../worker/src" && pwd)"
rm -rf "$pkg/_worker"
mkdir -p "$pkg/_worker"
cp -R "$worker_src/." "$pkg/_worker/"
echo "copied worker/src/ to deploy/aws/_worker/"
