#!/usr/bin/env bash
# fake-suite.sh <tree> — stands in for stop-check.sh: red iff FAIL_SUITE exists in the tree, or FAIL_CANDIDATE
# exists and the tree is a detached candidate/close worktree (so a branch can be green while its candidate is red).
tree="$1"
if [ -e "$tree/FAIL_SUITE" ]; then echo "fake-suite: RED ($tree/FAIL_SUITE present)"; exit 1; fi
case "$tree" in *candidate-*|*close-*) if [ -e "$tree/FAIL_CANDIDATE" ]; then echo "fake-suite: RED (candidate: FAIL_CANDIDATE present)"; exit 1; fi;; esac
echo "fake-suite: GREEN $tree"; exit 0
