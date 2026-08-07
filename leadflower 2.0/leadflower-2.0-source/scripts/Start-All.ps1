
$ErrorActionPreference = "Stop"

# Start Server in new window
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd `"$PSScriptRoot\..\server`"; pnpm dev"

# Start Client in new window
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd `"$PSScriptRoot\..\client`"; pnpm dev"
