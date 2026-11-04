#!/bin/sh
# Report what the upstream repository has published that this fork has not
# merged yet. Exits 0 when the fork is current, 1 when upstream is ahead,
# 2 when the fetch fails (offline, missing remote).
#
#   scripts/upstream-check.sh              human-readable summary
#   scripts/upstream-check.sh --porcelain  behind-count then one line per commit
set -eu

UPSTREAM_REMOTE=${UPSTREAM_REMOTE:-upstream}
UPSTREAM_BRANCH=${UPSTREAM_BRANCH:-$(git config --get fork.upstream-branch 2>/dev/null || echo main)}
PORCELAIN=0

if [ "${1:-}" = "--porcelain" ]; then
	PORCELAIN=1
fi

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
	echo "upstream-check: no '$UPSTREAM_REMOTE' remote. Add it with:" >&2
	echo "  git remote add $UPSTREAM_REMOTE https://github.com/aliou/pi-guardrails" >&2
	exit 2
fi

if ! git fetch --quiet "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"; then
	echo "upstream-check: could not fetch $UPSTREAM_REMOTE/$UPSTREAM_BRANCH" >&2
	exit 2
fi

REF="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
BEHIND=$(git rev-list --count "HEAD..$REF")

if [ "$BEHIND" -eq 0 ]; then
	if [ "$PORCELAIN" -eq 1 ]; then
		echo 0
	else
		echo "up to date with $REF"
	fi
	exit 0
fi

if [ "$PORCELAIN" -eq 1 ]; then
	echo "$BEHIND"
	git log --pretty=format:'%h %s' "HEAD..$REF"
else
	echo "$BEHIND commit(s) on $REF are not in this fork:"
	git log --pretty=format:'  %h  %s  (%an, %ad)' --date=short "HEAD..$REF"
	echo
	echo "merge them with: git merge $REF"
fi

exit 1
