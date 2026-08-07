
$ErrorActionPreference = "Stop"

# Build client
cd "$PSScriptRoot\..\client"
pnpm install
pnpm build

Write-Host "`nClient build done -> dist/"
Write-Host "To serve the SPA, use any static server (e.g., 'npx serve -s dist -l 5173')"
Write-Host "Ensure server API is running (PORT 4000) and client points to it via VITE_API_URL or proxy." -ForegroundColor Yellow
