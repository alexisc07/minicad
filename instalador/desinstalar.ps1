# Desinstala MiniCAD 3D (accesos directos, archivos y registro).
# Tus modelos guardados (.mcad) no se borran.
param([switch]$Silencioso)
$ErrorActionPreference = 'SilentlyContinue'
$clave = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MiniCAD3D'
$destino = (Get-ItemProperty $clave -ErrorAction SilentlyContinue).InstallLocation
if (-not $destino) { $destino = $PSScriptRoot }
$url = ([System.Uri](Join-Path $destino 'MiniCAD.html')).AbsoluteUri

# Sólo se borran los accesos directos que apuntan a esta instalación
$shell = New-Object -ComObject WScript.Shell
foreach ($lnkPath in @(
        (Join-Path ([Environment]::GetFolderPath('Desktop')) 'MiniCAD 3D.lnk'),
        (Join-Path ([Environment]::GetFolderPath('Programs')) 'MiniCAD 3D.lnk'))) {
    if ((Test-Path $lnkPath) -and $shell.CreateShortcut($lnkPath).Arguments -like "*$url*") {
        Remove-Item $lnkPath -Force
    }
}

Remove-Item $clave -Recurse -Force
Set-Location $env:TEMP
Remove-Item $destino -Recurse -Force

if (-not $Silencioso) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show('MiniCAD 3D se ha desinstalado. Tus archivos .mcad no se han borrado.', 'MiniCAD 3D') | Out-Null
}
