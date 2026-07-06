#!/usr/bin/env bash
# Smoke-test hook for Soccer Stats App.
# Runs once per ~90-min window (first message of each VS Code session).
# Any API failures are injected into Claude's context for automatic analysis + fix.

TS_FILE="$HOME/.claude/soccer-smoke-ts.txt"   # plain text epoch seconds — readable by bash
STATE_FILE="$HOME/.claude/soccer-smoke-state.json"
THROTTLE=5400  # 90 minutes

# ── Throttle: only run once per window ────────────────────────────────────────
LAST=0
[ -f "$TS_FILE" ] && LAST=$(cat "$TS_FILE" 2>/dev/null || echo 0)
NOW=$(date +%s)

if [ $(( NOW - LAST )) -lt $THROTTLE ]; then
    exit 0
fi

# ── Run smoke tests via PowerShell (curl has no SSL trust in Git Bash) ────────
WIN_STATE=$(cygpath -w "$STATE_FILE" 2>/dev/null || echo "C:\\Users\\tjzha\\.claude\\soccer-smoke-state.json")
WIN_TS=$(cygpath -w "$TS_FILE" 2>/dev/null || echo "C:\\Users\\tjzha\\.claude\\soccer-smoke-ts.txt")

OUTPUT=$(powershell -NoProfile -NonInteractive -Command "
\$base = 'https://soccer-stats-flame.vercel.app/api'
\$bypass = 'AGA8C83OSzC96vjQ6KOlm0idZck6EVE5'
\$headers = @{ 'x-vercel-protection-bypass' = \$bypass }
\$passes = 0; \$skips = 0; \$fails = [System.Collections.Generic.List[string]]::new()

function Check-Ep(\$label, \$url) {
    try {
        \$r = Invoke-WebRequest -Uri \$url -Headers \$headers -TimeoutSec 8 -UseBasicParsing -ErrorAction Stop
        \$script:passes++
    } catch {
        \$code = \$_.Exception.Response.StatusCode.value__
        if (\$code -eq 403) { \$script:skips++ }
        elseif (\$null -ne \$code) { \$script:fails.Add(\"\$label (HTTP \$code)\") }
        else { \$script:fails.Add(\"\$label (no response)\") }
    }
}

Check-Ep 'Health'            \"\$base/health\"
Check-Ep 'Competitions'      \"\$base/competitions\"
Check-Ep 'PL standings'      \"\$base/competitions/PL/standings\"
Check-Ep 'WC standings'      \"\$base/competitions/WC/standings\"
Check-Ep 'WC bracket'        \"\$base/competitions/WC/bracket\"
Check-Ep 'CL bracket'        \"\$base/competitions/CL/bracket\"
Check-Ep 'WC teams'          \"\$base/competitions/WC/teams\"
Check-Ep 'PL teams'          \"\$base/competitions/PL/teams\"
Check-Ep 'WC scorers'        \"\$base/competitions/WC/scorers\"
Check-Ep 'England WC lineup' \"\$base/teams/770/lineup?competition=WC\"
Check-Ep 'Arsenal PL lineup' \"\$base/teams/57/lineup?competition=PL\"

# Persist state JSON
\$now = [int](Get-Date -UFormat %s)
\$state = [ordered]@{ last_run = \$now; passes = \$passes; failures = @(\$fails) } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText('$WIN_STATE', \$state, [System.Text.Encoding]::UTF8)

# Save timestamp (no BOM — plain number)
[System.IO.File]::WriteAllText('$WIN_TS', \$now.ToString(), [System.Text.Encoding]::ASCII)

# Output failures
if (\$fails.Count -gt 0) {
    Write-Output \"[SMOKE TEST] \$(\$fails.Count) failure(s) detected (\$passes passed, \$skips auth-gated):\"
    \$fails | ForEach-Object { Write-Output \"  FAIL: \$_\" }
    Write-Output ''
    Write-Output 'Investigate and fix these API failures without changing existing functionality.'
}
" 2>/dev/null)

[ -n "$OUTPUT" ] && echo "$OUTPUT"
exit 0
