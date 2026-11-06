# Draws Maestro's app icon (same design as src/Maestro/wwwroot/icon.svg) into a multi-size .ico.
# Usage: powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1
Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot '..\src\Maestro\maestro.ico'
$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256

function New-IconPng([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.PixelOffsetMode = 'HighQuality'
  $g.ScaleTransform($size / 64.0, $size / 64.0)

  # Rounded square background
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 14; $d = $r * 2
  $path.AddArc(0, 0, $d, $d, 180, 90); $path.AddArc(64 - $d, 0, $d, $d, 270, 90)
  $path.AddArc(64 - $d, 64 - $d, $d, $d, 0, 90); $path.AddArc(0, 64 - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 16, 19, 24))), $path)

  # Spotify-green and YouTube-red circles, overlapping
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(230, 30, 215, 96))), 11, 18, 28, 28)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(217, 255, 61, 61))), 25, 18, 28, 28)

  # Play triangle
  $tri = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF 28, 25.5),
    (New-Object System.Drawing.PointF 28, 38.5),
    (New-Object System.Drawing.PointF 38, 32))
  $g.FillPolygon([System.Drawing.Brushes]::White, $tri)

  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  , $ms.ToArray()
}

# ICO container with PNG-compressed entries (supported since Windows Vista)
$images = foreach ($s in $sizes) { , (New-IconPng $s) }
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
