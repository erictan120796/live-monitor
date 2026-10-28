# Deliberately reproduces Windows PowerShell 5.1's lossy native $args forwarding.
$directory = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $directory 'node.exe'))) {
    $version = Get-ChildItem -LiteralPath (Join-Path $directory 'versions') -Directory |
        Where-Object { $_.Name -match '^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$' } |
        Sort-Object { $parts = $_.Name.Split('-')[0].Split('.'); [int]($parts[0] + $parts[1].PadLeft(2,'0') + $parts[2].PadLeft(2,'0')) } -Descending |
        Select-Object -First 1
    $directory = $version.FullName
}
& (Join-Path $directory 'node.exe') (Join-Path $directory 'index.js') $args
exit $LASTEXITCODE
