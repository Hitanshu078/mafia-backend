# Mafia game launcher — opens one terminal per player
# Run from C:\Games\Mafia while the server is running (pnpm dev:server)

$ServerDir = "$PSScriptRoot\apps\server"
$Players = @('Host', 'Alice', 'Bob', 'Charlie', 'Diana')

Write-Host ""
Write-Host "  Mafia Game Launcher" -ForegroundColor Cyan
Write-Host "  Make sure the server is running: pnpm dev:server" -ForegroundColor Yellow
Write-Host ""

foreach ($player in $Players) {
    $cmd = "cd '$ServerDir'; pnpm exec tsx src/__tests__/player-client.ts $player"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $cmd
    Write-Host "  Opened window for $player" -ForegroundColor Green
    Start-Sleep -Milliseconds 400
}

Write-Host ""
Write-Host "  All 5 windows opened!" -ForegroundColor Cyan
Write-Host "  Host: press (c) to create a room, then share the code." -ForegroundColor Yellow
Write-Host "  Others: press (j) and type the code to join." -ForegroundColor Yellow
Write-Host ""
