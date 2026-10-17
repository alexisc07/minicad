# Instala MiniCAD 3D para el usuario actual (no necesita permisos de administrador).
# Copia el programa, crea accesos directos y lo registra en "Aplicaciones instaladas".
param(
    [string]$Destino = (Join-Path $env:LOCALAPPDATA 'Programs\MiniCAD'),
    [switch]$Silencioso
)
$ErrorActionPreference = 'Stop'
$origen = $PSScriptRoot

Write-Host ''
Write-Host '  MiniCAD 3D - Instalación' -ForegroundColor Cyan
Write-Host '  ------------------------'

foreach ($f in 'MiniCAD.html', 'minicad.ico', 'desinstalar.ps1') {
    if (-not (Test-Path (Join-Path $origen $f))) {
        Write-Host "  Falta el archivo $f. Descomprime el ZIP completo antes de instalar." -ForegroundColor Red
        exit 1
    }
}

# Navegador: Chrome si está instalado, si no Edge
$navegador = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $navegador) {
    Write-Host '  No se encontró Google Chrome ni Microsoft Edge. Instala uno de los dos.' -ForegroundColor Red
    exit 1
}

# 1) Copiar archivos
New-Item -ItemType Directory -Force -Path $Destino | Out-Null
foreach ($f in 'MiniCAD.html', 'minicad.ico', 'desinstalar.ps1', 'version.txt', 'LEEME.txt') {
    $p = Join-Path $origen $f
    if (Test-Path $p) { Copy-Item $p -Destination $Destino -Force }
}
Write-Host "  Programa copiado en: $Destino" -ForegroundColor Green

# 2) Accesos directos (Escritorio y menú Inicio)
$url = ([System.Uri](Join-Path $Destino 'MiniCAD.html')).AbsoluteUri
$ico = Join-Path $Destino 'minicad.ico'
$shell = New-Object -ComObject WScript.Shell
$accesos = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'MiniCAD 3D.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'MiniCAD 3D.lnk')
)
foreach ($lnkPath in $accesos) {
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = $navegador
    $lnk.Arguments = "--app=`"$url`""
    $lnk.WorkingDirectory = $Destino
    $lnk.Description = 'MiniCAD 3D - modelador CAD ligero'
    $lnk.IconLocation = "$ico,0"
    $lnk.Save()
}
Write-Host '  Accesos directos creados en el Escritorio y en el menú Inicio.' -ForegroundColor Green

# 3) Registrar en "Aplicaciones instaladas" para poder desinstalar desde Configuración
$version = '1.0.0'
$vf = Join-Path $Destino 'version.txt'
if (Test-Path $vf) { $version = (Get-Content $vf -Raw).Trim() }
$kb = [int]((Get-ChildItem $Destino | Measure-Object Length -Sum).Sum / 1024)
$clave = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MiniCAD3D'
New-Item -Path $clave -Force | Out-Null
$props = @{
    DisplayName     = 'MiniCAD 3D'
    DisplayVersion  = $version
    Publisher       = 'alexisc07'
    DisplayIcon     = $ico
    InstallLocation = $Destino
    URLInfoAbout    = 'https://github.com/alexisc07/minicad'
    UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Destino 'desinstalar.ps1')`""
}
foreach ($k in $props.Keys) { Set-ItemProperty -Path $clave -Name $k -Value $props[$k] }
New-ItemProperty -Path $clave -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $clave -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $clave -Name EstimatedSize -Value $kb -PropertyType DWord -Force | Out-Null

Write-Host ''
Write-Host "  MiniCAD 3D $version instalado correctamente." -ForegroundColor Cyan
Write-Host '  Ábrelo desde el Escritorio o buscando "MiniCAD" en el menú Inicio.'
Write-Host '  Para quitarlo: Configuración > Aplicaciones > MiniCAD 3D > Desinstalar.'
Write-Host ''

if (-not $Silencioso) { Start-Process $accesos[0] }
