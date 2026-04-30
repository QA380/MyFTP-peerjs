# Read the original file
$filePath = "c:\Users\vince\Downloads\Project_Management\HTML-CSS\MyFTP-peerjs-\app\page.tsx"
$content = Get-Content -Path $filePath -Raw

# Find the last "return (" line number (the main one)
$lines = $content -split "`n"
$returnIndex = $null
for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    if ($lines[$i].Trim() -eq "return (" -and $i -gt 2000) {  # Should be near end
        $returnIndex = $i
        break
    }
}

Write-Host "Last return index: $returnIndex"
Write-Host "Total lines: $($lines.Count)"

# Show lines around return
Write-Host "=== Context around return ==="
if ($returnIndex) {
    for ($i = [Math]::Max(0, $returnIndex - 3); $i -lt [Math]::Min($lines.Count, $returnIndex + 10); $i++) {
        Write-Host "[$i] $($lines[$i])"
    }
}

# Show lines around end to find closing
Write-Host "`n=== Last 10 lines ==="
for ($i = [Math]::Max(0, $lines.Count - 10); $i -lt $lines.Count; $i++) {
    Write-Host "[$i] $($lines[$i])"
}
