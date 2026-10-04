#!/usr/bin/env bash
# Shared logic for the three warm-cache workflow files (warm-cache-a/b/c.yml), each of
# which calls this with its own tier letter. Kept as one script, not duplicated per
# workflow file, so a fix only needs to be made once.
#
# Phase 2 of the "slow first load after idle" optimization plan (see BACKLOG.md).
# No functional change to the app — this only GETs public read endpoints that are
# already served by every page load, so their existing cache-write paths (fixed in
# Phase 1 to use waitUntil) populate/refresh the rows the home page, sidebar stat
# leaders and standings depend on, instead of leaving that to chance real-user or
# smoke-test traffic. A GET on a stale key triggers the server's own background
# stale-while-revalidate refresh; a GET on a missing key creates it (safe now that
# Phase 1 stopped those writes from being silently dropped on a cold Vercel instance).
#
# Deliberately NOT warmed (out of scope per the plan): team pages (lineup, schedule,
# honours) and news/Gemini — those are per-team/per-article, not core/shared pages,
# and news specifically must not spend extra Gemini free-tier quota here.
#
# Usage: warm-cache.sh <A|B|C>
# Requires env: BYPASS (Vercel protection-bypass token), BASE (API base URL).

set -u
TIER="${1:-}"
set +e

HIT=0; SKIP=0; FAIL=0; CONSEC_FAIL=0; ABORTED=0
LOGFILE=$(mktemp)

month_start() { date -u -d "$(date -u +%Y-%m-01) +$1 month" +%Y-%m-%d; }
PREV_FROM=$(month_start -1); PREV_TO=$(month_start 0)
CUR_FROM=$(month_start 0);   CUR_TO=$(month_start 1)
NEXT_FROM=$(month_start 1);  NEXT_TO=$(month_start 2)
DAY_OF_MONTH=$(date -u +%-d)

# One GET. Once 3 consecutive 429/5xx/network-failure responses are seen, sets
# ABORTED=1 and every later call in this run becomes a free no-op (checked first,
# below) — a sign fd.org (or the app itself) is already under pressure, so backing
# off entirely for the rest of this run is safer than continuing to add load.
#
# curl -w "%{http_code}" prints "000" (not an empty string) on a connection failure,
# DNS failure, TLS failure or --max-time timeout — both forms are treated as the same
# transient failure here, since neither means the server actually answered.
hit() {
  local label="$1" url="$2" code
  if [ "$ABORTED" = "1" ]; then
    echo "SKIP -- $label (aborted earlier this run)" | tee -a "$LOGFILE"
    return 0
  fi
  code=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "x-vercel-protection-bypass: $BYPASS" \
    --max-time 60 \
    "$url" 2>/dev/null)
  case "$code" in
    200|404)
      echo "OK   -- $label ($code)" | tee -a "$LOGFILE"
      HIT=$((HIT+1)); CONSEC_FAIL=0 ;;
    403)
      # A stable, expected outcome for paid-tier-only competitions — not evidence the
      # service just recovered, so (unlike 200/404) this deliberately does NOT reset
      # CONSEC_FAIL. Otherwise a run that alternates real failures with paid-tier
      # codes (FAIL, FAIL, 403, FAIL, FAIL, 403, ...) could never reach the abort
      # threshold despite being under sustained failure the whole time.
      echo "SKIP -- $label ($code, paid tier)" | tee -a "$LOGFILE"
      SKIP=$((SKIP+1)) ;;
    429|500|502|503|504|000|"")
      if [ -z "$code" ] || [ "$code" = "000" ]; then
        echo "FAIL -- $label (no response / connection failure)" | tee -a "$LOGFILE"
      else
        echo "FAIL -- $label (HTTP $code)" | tee -a "$LOGFILE"
      fi
      FAIL=$((FAIL+1)); CONSEC_FAIL=$((CONSEC_FAIL+1)) ;;
    *)
      echo "FAIL -- $label (HTTP $code)" | tee -a "$LOGFILE"
      FAIL=$((FAIL+1)); CONSEC_FAIL=0 ;;
  esac
  if [ "$CONSEC_FAIL" -ge 3 ]; then
    echo "ABORT -- 3 consecutive failures, skipping the rest of this run" | tee -a "$LOGFILE"
    ABORTED=1
  fi
  return 0
}

# No-op once aborted, same as hit() — avoids paying out a loop's full pacing delay
# (e.g. Tier B's ~34s/code) once there is nothing left to usefully pace.
maybe_sleep() {
  [ "$ABORTED" = "1" ] && return 0
  sleep "$1"
}

# Live competition codes. On failure, callers skip their per-competition loop for
# this run rather than falling back to a hand-maintained list — a fallback list is
# itself a 4th independent place this app's competition set would need to be kept in
# sync (alongside server/src/services/espnService.ts's ESPN_LEAGUES,
# footballApi.ts's EURO_COMPS/CONTINENTAL_CLUB_COMP_CODES, and smoke-test.yml's
# enumerated checks), and one that already silently fell out of date once during
# review (missing EL/ECL). Skipping loudly beats guessing silently.
fetch_codes() {
  curl -s -H "x-vercel-protection-bypass: $BYPASS" --max-time 30 "$BASE/competitions" 2>/dev/null \
    | jq -r '[.[].code] | join(" ")' 2>/dev/null
}

warm_next_month_fixtures() {
  hit "fixtures (next month) $NEXT_FROM..$NEXT_TO" "$BASE/fixtures?dateFrom=$NEXT_FROM&dateTo=$NEXT_TO"
}

echo "=== Cache warmer: tier $TIER, $(date -u '+%Y-%m-%d %H:%M UTC') ===" | tee -a "$LOGFILE"

case "$TIER" in
  A)
    hit "health" "$BASE/health"
    maybe_sleep 2
    hit "competitions" "$BASE/competitions"
    maybe_sleep 2
    hit "live-matches" "$BASE/live-matches"
    maybe_sleep 2
    hit "fixtures $CUR_FROM..$CUR_TO" "$BASE/fixtures?dateFrom=$CUR_FROM&dateTo=$CUR_TO"
    # From the 25th on, also warm next month so the rollover on day 1 is a
    # stale-serve, not a blocking miss — mirrors the warm-up's own 3-window set.
    if [ "$DAY_OF_MONTH" -ge 25 ]; then
      maybe_sleep 2
      warm_next_month_fixtures
    fi
    for code in PL PD BL1 SA FL1 CL; do
      maybe_sleep 3
      hit "$code standings" "$BASE/competitions/$code/standings"
    done
    ;;

  B)
    CODES=$(fetch_codes)
    if [ -z "$CODES" ]; then
      echo "FAIL -- could not fetch competition list, skipping per-competition warm this run" | tee -a "$LOGFILE"
      FAIL=$((FAIL+1))
    else
      for code in $CODES; do
        hit "$code standings"    "$BASE/competitions/$code/standings"
        maybe_sleep 10
        hit "$code scorers"      "$BASE/competitions/$code/scorers"
        maybe_sleep 10
        # live-scorers additionally calls getFinishedMatchList for CL/EL/ECL/WC/EC —
        # up to 3 fd.org calls for those codes, not 1, hence the longer pace after it.
        hit "$code live-scorers" "$BASE/competitions/$code/live-scorers"
        maybe_sleep 25
      done
    fi
    hit "fixtures (previous month) $PREV_FROM..$PREV_TO" "$BASE/fixtures?dateFrom=$PREV_FROM&dateTo=$PREV_TO"
    maybe_sleep 3
    warm_next_month_fixtures
    ;;

  C)
    # Forces the team-search index to build (if missing) and persist — see
    # routes/teams.ts GET /teams/search. One letter is enough to build the full
    # index; results themselves are irrelevant here. This is the same ~13-call
    # fd.org burst a real user's first-ever cold search would trigger anyway; this
    # just makes it happen once, at a known, low-traffic time, instead of at
    # whatever moment a real user happens to hit it.
    hit "team search index build" "$BASE/teams/search?q=ar"
    CODES=$(fetch_codes)
    if [ -z "$CODES" ]; then
      echo "FAIL -- could not fetch competition list, skipping seasons warm this run" | tee -a "$LOGFILE"
      FAIL=$((FAIL+1))
    else
      for code in $CODES; do
        maybe_sleep 5
        hit "$code seasons" "$BASE/competitions/$code/seasons"
      done
    fi
    warm_next_month_fixtures
    ;;

  *)
    echo "Unknown tier '$TIER' (usage: warm-cache.sh <A|B|C>)" | tee -a "$LOGFILE"
    exit 1
    ;;
esac

SUMMARY="tier=$TIER hit=$HIT skip=$SKIP fail=$FAIL"
echo "" | tee -a "$LOGFILE"
echo "=== WARM COMPLETE: $SUMMARY ===" | tee -a "$LOGFILE"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Cache Warmer — tier $TIER — $(date -u '+%Y-%m-%d %H:%M UTC')"
    echo "**$SUMMARY**"
    echo '```'
    cat "$LOGFILE"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi

rm -f "$LOGFILE"
# Never fails the run on individual endpoint misses (that's the whole point — a miss
# here just means that data stays on the normal on-demand path). Only a hard script
# error (e.g. an unknown tier, caught above) exits non-zero.
exit 0
