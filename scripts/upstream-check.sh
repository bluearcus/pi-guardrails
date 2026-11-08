#!/bin/sh
# Report what the upstream repository has published that this fork has no decision on yet.
# Exits 0 when there is nothing outstanding, 1 when there is, 2 when the fetch fails (offline,
# missing remote, bad revision).
#
# The ledger (scripts/upstream-ledger.txt by default) records every upstream commit this fork has
# accounted for as `taken` or `refused`, so a cherry-picked fix stops being reported forever:
# `git rev-list HEAD..upstream/main` counts commits, and a cherry-pick makes a new commit id, so
# the raw count never falls.
#
#   scripts/upstream-check.sh                  human-readable summary
#   scripts/upstream-check.sh --porcelain      outstanding count, then one line per commit
#   scripts/upstream-check.sh take <sha>...    record upstream commits as brought down
#   scripts/upstream-check.sh refuse <sha>...  record a decision not to take them
#   scripts/upstream-check.sh forget <sha>...  drop ledger entries
#   scripts/upstream-check.sh ledger           show the ledger
set -eu

UPSTREAM_REMOTE=${UPSTREAM_REMOTE:-upstream}
UPSTREAM_BRANCH=${UPSTREAM_BRANCH:-$(git config --get fork.upstream-branch 2>/dev/null || echo main)}
ROOT=$(git rev-parse --show-toplevel)
LEDGER=${LEDGER:-$ROOT/scripts/upstream-ledger.txt}
LEDGER_REMOTE=${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}

ledger_verdict() {
	[ -f "$LEDGER" ] || return 0
	awk -v want="$1" '$1 == want { print $2 }' "$LEDGER"
}

ledger_all() {
	[ -f "$LEDGER" ] || return 0
	awk '$1 == "taken" || $1 == "refused" { print $2 }' "$LEDGER"
}

# Upstream commits with no verdict: the range, minus every ledger sha that is a prefix of one.
ledger_filter() {
	ledger_all >"$TMP_LEDGER"
	git rev-list "$1" >"$TMP_ALL"
	awk '
		NR == FNR { if (NF) want[$1] = 1; next }
		{
			hit = 0
			for (k in want) if (index($1, k) == 1) { hit = 1; break }
			if (!hit) print $1
		}
	' "$TMP_LEDGER" "$TMP_ALL"
}

# Ledger entries upstream no longer has: a rewrite or a rebased branch makes a verdict stale.
ledger_stale() {
	for sha in $(ledger_all); do
		if ! git rev-parse --verify --quiet "$sha^{commit}" >/dev/null; then
			echo "$sha missing"
		elif ! git merge-base --is-ancestor "$sha" "$LEDGER_REMOTE" 2>/dev/null; then
			echo "$sha not on $LEDGER_REMOTE"
		fi
	done
}

record() {
	verdict=$1
	shift
	if [ "$#" -eq 0 ]; then
		echo "upstream-check: $verdict needs at least one commit" >&2
		exit 2
	fi
	if [ ! -f "$LEDGER" ]; then
		printf '# Upstream commits this fork has accounted for.\n# <verdict> <sha> <subject>\n' >"$LEDGER"
	fi
	for arg in "$@"; do
		sha=$(git rev-parse --verify --quiet "$arg^{commit}" 2>/dev/null || true)
		if [ -z "$sha" ]; then
			echo "upstream-check: '$arg' is not a commit this repository knows about" >&2
			exit 2
		fi
		short=$(git rev-parse --short=12 "$sha")
		subject=$(git log -1 --pretty=%s "$sha")
		# Replace a verdict that changed its mind, otherwise append.
		awk -v short="$short" '$1 == "taken" || $1 == "refused" { if ($2 == short) next; print }' "$LEDGER" >"$TMP_LEDGER"
		printf '%s %s %s\n' "$verdict" "$short" "$subject" >>"$TMP_LEDGER"
		mv "$TMP_LEDGER" "$LEDGER"
		echo "$verdict $short  $subject"
	done
	echo "ledger: $LEDGER"
}

show_ledger() {
	if [ ! -f "$LEDGER" ]; then
		echo "no ledger at $LEDGER"
		exit 0
	fi
	sed -n '/^[[:space:]]*\(taken\|refused\)[[:space:]]/p' "$LEDGER" |
		awk '{ verdict = $1; sha = $2; $1 = ""; $2 = ""; sub(/^  */, ""); printf "  %-8s %-13s %s\n", verdict, sha, $0 }'
}

TMP_LEDGER=$(mktemp)
TMP_ALL=$(mktemp)
trap 'rm -f "$TMP_LEDGER" "$TMP_ALL"' EXIT HUP INT TERM

case "${1:-check}" in
	take)
		shift
		record taken "$@"
		exit 0
		;;
	refuse)
		shift
		record refused "$@"
		exit 0
		;;
	forget)
		shift
		for arg in "$@"; do
			short=$(git rev-parse --quiet --verify "$arg^{commit}" 2>/dev/null || echo "$arg")
			awk -v short="$short" '$1 == "taken" || $1 == "refused" { if ($2 == short || index(short, $2) == 1) next; print }' "$LEDGER" >"$TMP_LEDGER"
			mv "$TMP_LEDGER" "$LEDGER"
			echo "dropped $short from the ledger"
		done
		exit 0
		;;
	ledger)
		show_ledger
		exit 0
		;;
	check | --porcelain)
		;;
	*)
		echo "usage: upstream-check.sh [--porcelain | take <sha>... | refuse <sha>... | forget <sha>... | ledger]" >&2
		exit 2
		;;
esac

PORCELAIN=0
[ "${1:-}" = "--porcelain" ] && PORCELAIN=1

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
	echo "upstream-check: no '$UPSTREAM_REMOTE' remote. Add the repository this fork was forked from:" >&2
	echo "  git remote add $UPSTREAM_REMOTE <upstream repo url>" >&2
	exit 2
fi

if ! git fetch --quiet "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"; then
	echo "upstream-check: could not fetch $UPSTREAM_REMOTE/$UPSTREAM_BRANCH" >&2
	exit 2
fi

REF="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
OUTSTANDING=$(ledger_filter "HEAD..$REF" | awk 'NF { print }')
TAKEN=$(ledger_verdict taken | awk 'END { print NR }')
REFUSED=$(ledger_verdict refused | awk 'END { print NR }')
STALE=$(ledger_stale)

if [ -n "$STALE" ]; then
	echo "$STALE" | while IFS= read -r line; do
		echo "upstream-check: stale ledger entry: $line" >&2
	done
fi

if [ -z "$OUTSTANDING" ]; then
	if [ "$PORCELAIN" -eq 1 ]; then
		echo 0
	elif [ "$((TAKEN + REFUSED))" -gt 0 ]; then
		echo "up to date with $REF ($TAKEN taken, $REFUSED refused, $LEDGER_REMOTE)"
	else
		echo "up to date with $REF"
	fi
	exit 0
fi

if [ "$PORCELAIN" -eq 1 ]; then
	echo "$OUTSTANDING" | awk 'END { print NR }'
	echo "$OUTSTANDING" | while IFS= read -r sha; do
		git log -1 --pretty=format:'%h %s' "$sha"
		echo
	done
else
	echo "$OUTSTANDING" | awk 'END { print NR }' | while IFS= read -r count; do
		echo "$count commit(s) on $REF have no verdict in this fork:"
	done
	echo "$OUTSTANDING" | while IFS= read -r sha; do
		git log -1 --pretty=format:'  %h  %s  (%an, %ad)' --date=short "$sha"
		echo
	done
	echo
	echo "bring one down:  git cherry-pick <sha> && scripts/upstream-check.sh take <sha>"
	echo "decline one:     scripts/upstream-check.sh refuse <sha>   (write the reason in FORK.md)"
fi

exit 1
