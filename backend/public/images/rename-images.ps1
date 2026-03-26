$srcDir = 'c:\Users\Admin\Documents\trae_projects\attentionx\backend\public\images'
$tempDir = Join-Path $srcDir 'temp'
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

# Mapping: current file number -> new file number
# Based on: 1=axiom->9, 2=cursor->3, 3=openclaw->1, 4=anthropic->5, 5=lovable->2
# 6=browser use->6, 7=openai->4, 8=dedalus labs->7, 9=dome->11, 10=autumn ai->8
# 11=multifactor->10, 12-19 stay the same

$mapping = @{
    '1.png' = '9.png'
    '2.png' = '3.png'
    '3.png' = '1.png'
    '4.png' = '5.png'
    '5.png' = '2.png'
    '6.png' = '6.png'
    '7.png' = '4.png'
    '8.png' = '7.png'
    '9.png' = '11.png'
    '10.png' = '8.png'
    '11.png' = '10.png'
    '12.png' = '12.png'
    '13.png' = '13.png'
    '14.png' = '14.png'
    '15.png' = '15.png'
    '16.png' = '16.png'
    '17.png' = '17.png'
    '18.png' = '18.png'
    '19.png' = '19.png'
}

# Copy all files to temp with new names
foreach ($key in $mapping.Keys) {
    $srcPath = Join-Path $srcDir $key
    $newName = $mapping[$key]
    $tempPath = Join-Path $tempDir $newName
    if (Test-Path $srcPath) {
        Copy-Item $srcPath $tempPath
        Write-Host "Copied $key -> temp/$newName"
    }
}

# Delete old files from source
Get-ChildItem $srcDir -Filter '*.png' | Remove-Item
Write-Host 'Deleted old files from source'

# Move renamed files back
Get-ChildItem $tempDir -Filter '*.png' | Move-Item -Destination $srcDir
Write-Host 'Moved renamed files back to source'

# Remove temp directory
Remove-Item $tempDir
Write-Host 'Cleanup complete'
Write-Host ''
Write-Host '✅ All images renamed successfully!'
Write-Host ''
Write-Host 'New mapping:'
Write-Host '  1.png = Openclaw (was 3.png)'
Write-Host '  2.png = Lovable (was 5.png)'
Write-Host '  3.png = Cursor (was 2.png)'
Write-Host '  4.png = OpenAI (was 7.png)'
Write-Host '  5.png = Anthropic (was 4.png)'
Write-Host '  6.png = Browser Use (same)'
Write-Host '  7.png = Dedalus Labs (was 8.png)'
Write-Host '  8.png = Autumn (was 10.png)'
Write-Host '  9.png = Axiom (was 1.png)'
Write-Host ' 10.png = Multifactor (was 11.png)'
Write-Host ' 11.png = Dome (was 9.png)'
Write-Host ' 12-19.png = Same (GrazeMate, Tornyol, Pocket, Caretta, AxionOrbital, Freeport, Ruvo, Lightberry)'
