#Requires -Version 5.1
<#
  Скачивает портируемую сборку Node.js для Windows и распаковывает её в папку
  проекта (.node). Права администратора не нужны, система не меняется —
  удалить Node можно вместе с папкой.

  Вызывается из start.cmd, когда Node.js в системе не найден или он старее 20.
#>
param(
  [string]$Version = 'v22.23.1',
  [string]$Dest = (Join-Path $PSScriptRoot '..\.node')
)

$ErrorActionPreference = 'Stop'
# Без этого Invoke-WebRequest рисует прогресс-бар и качает в разы медленнее.
$ProgressPreference = 'SilentlyContinue'

$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
$zipName = "node-$Version-win-$arch.zip"
$baseUrl = "https://nodejs.org/dist/$Version"
$zipUrl = "$baseUrl/$zipName"
$tmpZip = Join-Path $env:TEMP $zipName

Write-Host "  Скачиваю Node.js $Version ($arch), около 30 МБ..."

try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip -UseBasicParsing
} catch {
    Write-Host ""
    Write-Host "  Не удалось скачать Node.js. Проверьте подключение к интернету"
    Write-Host "  или поставьте Node.js вручную: https://nodejs.org/"
    Write-Host "  Адрес загрузки: $zipUrl"
    exit 1
}

# Сверяем контрольную сумму: качаем исполняемый файл, подмена должна быть видна.
try {
    $sums = (Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -UseBasicParsing).Content
    $line = ($sums -split "`n" | Where-Object { $_ -match ([regex]::Escape($zipName) + '\s*$') } | Select-Object -First 1)
    if ($line) {
        $expected = ($line -split '\s+')[0].ToUpper()
        $actual = (Get-FileHash -Path $tmpZip -Algorithm SHA256).Hash.ToUpper()
        if ($expected -ne $actual) {
            Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
            Write-Host "  Контрольная сумма не совпала — файл повреждён или подменён. Скачивание отменено."
            exit 1
        }
        Write-Host "  Контрольная сумма совпала."
    }
} catch {
    Write-Host "  Не удалось проверить контрольную сумму, продолжаю без проверки."
}

Write-Host "  Распаковываю в $Dest ..."

try {
    if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
    New-Item -ItemType Directory -Path $Dest -Force | Out-Null
    Expand-Archive -Path $tmpZip -DestinationPath $Dest -Force

    # Внутри архива лежит папка node-vX-win-x64 — поднимаем её содержимое наверх.
    $inner = Get-ChildItem -Path $Dest -Directory | Select-Object -First 1
    if ($inner) {
        Get-ChildItem -Path $inner.FullName | Move-Item -Destination $Dest -Force
        Remove-Item $inner.FullName -Recurse -Force
    }
} catch {
    Write-Host "  Не удалось распаковать архив: $($_.Exception.Message)"
    exit 1
} finally {
    Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
}

$nodeExe = Join-Path $Dest 'node.exe'
if (-not (Test-Path $nodeExe)) {
    Write-Host "  В архиве не оказалось node.exe — что-то пошло не так."
    exit 1
}

Write-Host "  Готово: Node.js $Version лежит в $Dest"
exit 0
