# Draws Maestro's app icon from the horizontal logo into a multi-size .ico.
# Usage: powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
Add-Type -AssemblyName System.Drawing

$logoPath = Join-Path $PSScriptRoot '..\logo\logo-horizontal.png'
$out = Join-Path $PSScriptRoot '..\src\Maestro\maestro.ico'
$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256

if (-not (Test-Path $logoPath)) {
  Write-Error "Logo not found at $logoPath"
  exit 1
}

$src = [System.Drawing.Bitmap]::FromFile($logoPath)

# Clip corners with squircle path for clean transparency
$master = New-Object System.Drawing.Bitmap $src.Width, $src.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$mg = [System.Drawing.Graphics]::FromImage($master)
$mg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$mg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$mg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

$r = 276.0; $d = $r * 2.0
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0.0, 0.0, $d, $d, 180.0, 90.0)
$path.AddArc(1254.0 - $d, 0.0, $d, $d, 270.0, 90.0)
$path.AddArc(1254.0 - $d, 1254.0 - $d, $d, $d, 0.0, 90.0)
$path.AddArc(0.0, 1254.0 - $d, $d, $d, 90.0, 90.0)
$path.CloseFigure()

$mg.SetClip($path)
$mg.DrawImage($src, 0, 0, 1254, 1254)
$mg.Dispose()

function New-IconPng([int]$size, [System.Drawing.Bitmap]$sourceBmp) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.DrawImage($sourceBmp, 0, 0, $size, $size)
  $g.Dispose()

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  , $ms.ToArray()
}

$images = foreach ($s in $sizes) { , (New-IconPng $s $master) }
$master.Dispose()
$src.Dispose()

# ICO container with PNG-compressed entries (supported since Windows Vista)
$fs = [System.IO.File]::Create($out)
$w = New-Object System.IO.BinaryWriter $fs
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $len = $images[$i].Length
  $dim = if ($s -ge 256) { 0 } else { $s }
  $w.Write([byte]$dim); $w.Write([byte]$dim); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$len); $w.Write([uint32]$offset)
  $offset += $len
}
foreach ($img in $images) { $w.Write($img) }
$w.Close()
Write-Output "Wrote $out"
