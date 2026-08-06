
param(
  [string]$Api = "http://localhost:4000",
  [string]$KeyLabel = "SelfTest Key"
)

Write-Host "== API Health ==" -ForegroundColor Cyan
try {
  $h = Invoke-RestMethod -Uri "$Api/healthz" -Method GET
  $h | ConvertTo-Json -Depth 5
} catch { Write-Host "Health check failed:" $_.Exception.Message -ForegroundColor Red }

Write-Host "`n== Webhook Keys ==" -ForegroundColor Cyan
try {
  $keys = Invoke-RestMethod -Uri "$Api/api/webhooks/keys" -Method GET
  if (-not $keys -or $keys.Count -eq 0) {
    $null = Invoke-RestMethod -Uri "$Api/api/webhooks/keys" -Method POST -ContentType "application/json" -Body (@{ label=$KeyLabel } | ConvertTo-Json)
    $keys = Invoke-RestMethod -Uri "$Api/api/webhooks/keys" -Method GET
  }
  $keys | ConvertTo-Json -Depth 5
  $key = $keys[0].key
  Write-Host "Using webhook key:" $key -ForegroundColor Yellow
} catch { Write-Host "Webhook key error:" $_.Exception.Message -ForegroundColor Red }

Write-Host "`n== Workflows ==" -ForegroundColor Cyan
try {
  $wfs = Invoke-RestMethod -Uri "$Api/api/workflows" -Method GET
  if (-not $wfs -or $wfs.Count -eq 0) {
    # minimal sample
    $wf = @{
      name = "SelfTest Workflow"
      status = "published"
      nodes = @(
        @{ id="t1"; type="trigger.webhook"; position=@{x=50;y=80}; data=@{ webhookKey=$key } }
        @{ id="n1"; type="action.log"; position=@{x=300;y=80}; data=@{ message="hello from selftest" } }
      )
      edges = @(@{ id="e1"; source="t1"; target="n1" })
    }
    $null = Invoke-RestMethod -Uri "$Api/api/workflows" -Method POST -ContentType "application/json" -Body ($wf | ConvertTo-Json -Depth 6)
    $wfs = Invoke-RestMethod -Uri "$Api/api/workflows" -Method GET
  }
  $wfs | ConvertTo-Json -Depth 6
  $wfId = $wfs[0]._id
  Write-Host "Using workflow:" $wfId -ForegroundColor Yellow
} catch { Write-Host "Workflow error:" $_.Exception.Message -ForegroundColor Red }

Write-Host "`n== Fire Test Webhook ==" -ForegroundColor Cyan
try {
  $payload = @{ name="SIP Calculator DEMAT Lead"; Phone="9000000000" } | ConvertTo-Json
  $resp = Invoke-RestMethod -Uri "$Api/api/webhooks/in/$key" -Method POST -ContentType "application/json" -Body $payload
  $resp | ConvertTo-Json -Depth 6
} catch { Write-Host "Webhook error:" $_.Exception.Message -ForegroundColor Red }

Start-Sleep -Seconds 2

Write-Host "`n== Executions ==" -ForegroundColor Cyan
try {
  $xs = Invoke-RestMethod -Uri "$Api/api/executions" -Method GET
  $xs | ConvertTo-Json -Depth 6
} catch { Write-Host "Executions error:" $_.Exception.Message -ForegroundColor Red }

Write-Host "`n== Logs (recent) ==" -ForegroundColor Cyan
try {
  $logs = Invoke-RestMethod -Uri "$Api/api/logs" -Method GET
  $logs | Select-Object -First 5 | ConvertTo-Json -Depth 6
} catch { Write-Host "Logs error:" $_.Exception.Message -ForegroundColor Red }
