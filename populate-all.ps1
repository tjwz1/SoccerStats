$logFile = "C:\Users\tjzha\AppData\Local\Temp\server-dev.log"
$baseUrl = "http://localhost:3001/api/admin/populate-wiki-stats"

function Invoke-Batch([string]$teams) {
    try {
        $r = Invoke-WebRequest -Uri ($baseUrl + "?teams=" + $teams) -Method POST -UseBasicParsing -TimeoutSec 15
        Write-Host ("[batch] accepted: " + $r.Content)
    } catch {
        Write-Host ("[batch] ERROR: " + $_)
    }
}

function Wait-Marker([string]$marker) {
    Write-Host ("[wait] watching for: " + $marker)
    for ($i = 0; $i -lt 360; $i++) {
        Start-Sleep -Seconds 10
        $tail = (Get-Content $logFile -Tail 80 -ErrorAction SilentlyContinue) -join "`n"
        if ($tail -match [regex]::Escape($marker)) {
            Write-Host ("[wait] found: " + $marker)
            return $true
        }
    }
    Write-Host ("[wait] TIMEOUT: " + $marker)
    return $false
}

# La Liga batch 1 already started externally — just wait for it
Write-Host "[seq] Waiting for La Liga batch 1..."
if (-not (Wait-Marker "real_betis done")) { exit 1 }
Start-Sleep -Seconds 5

Write-Host "[seq] La Liga batch 2"
Invoke-Batch "real_sociedad,villarreal,valencia,alaves,elche,girona,celta,sevilla,real_oviedo"
if (-not (Wait-Marker "real_oviedo done")) { exit 1 }
Start-Sleep -Seconds 5

Write-Host "[seq] Bundesliga batch 1"
Invoke-Batch "fc_koeln,hoffenheim,hsv,stuttgart,wolfsburg,bremen,mainz,augsburg"
if (-not (Wait-Marker "augsburg done")) { exit 1 }
Start-Sleep -Seconds 5

Write-Host "[seq] Bundesliga batch 2"
Invoke-Batch "freiburg,mgladbach,st_pauli,union_berlin,heidenheim,rb_leipzig"
if (-not (Wait-Marker "rb_leipzig done")) { exit 1 }
Start-Sleep -Seconds 5

Write-Host "[seq] Premier League batch 1"
Invoke-Batch "aston_villa,everton,fulham,man_united,sunderland,wolves,burnley,leeds"
if (-not (Wait-Marker "leeds done")) { exit 1 }
Start-Sleep -Seconds 5

Write-Host "[seq] Premier League batch 2"
Invoke-Batch "nottingham,crystal_palace,brighton,brentford,west_ham,bournemouth"
if (-not (Wait-Marker "bournemouth done")) { exit 1 }
Start-Sleep -Seconds 5

Write-Host "[seq] Serie A batch 1"
Invoke-Batch "milan,fiorentina,roma,bologna,cagliari,genoa,lazio,parma"
if (-not (Wait-Marker "parma done")) { exit 1 }
Start-Sleep -Seconds 5

Write-Host "[seq] Serie A batch 2"
Invoke-Batch "udinese,verona,cremonese,sassuolo,pisa,torino,lecce,como"
if (-not (Wait-Marker "como done")) { exit 1 }
Start-Sleep -Seconds 5

Write-Host "[seq] Ligue 1 batch 1"
Invoke-Batch "toulouse,brest,auxerre,lille,nice,lyon,lorient,rennes"
if (-not (Wait-Marker "rennes done")) { exit 1 }
Start-Sleep -Seconds 5

Write-Host "[seq] Ligue 1 batch 2"
Invoke-Batch "angers,le_havre,nantes,metz,lens,strasbourg,paris_fc"
if (-not (Wait-Marker "paris_fc done")) { exit 1 }

Write-Host "[seq] ALL DONE"
