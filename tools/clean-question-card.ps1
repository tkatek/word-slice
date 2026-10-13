# Word Slice — cleans the uploaded question-card photo into a reusable asset.
# Source: assets/ui/question-card-reference.png (the exact uploaded design).
# Output: assets/ui/question-card.png with the baked-in badge text and the
# countdown pill's clock + "Starting in 4s" removed by per-row/per-column
# gradient reconstruction from the surrounding artwork (no flat patches).
# The middle title area in this photo is already blank parchment, and the
# progress track is already empty.
# Run:  powershell -ExecutionPolicy Bypass -File tools/clean-question-card.ps1
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$UiDir = Join-Path $Root 'assets\ui'
$rng = New-Object System.Random(11)

$bmp = [System.Drawing.Bitmap]::FromFile((Join-Path $UiDir 'question-card-reference.png'))

# --- Badge text removal: rebuild the wood between clean rows above/below. ---
$badgeLeft = 556; $badgeRight = 1116
$badgeTopSample = 108   # clean wood above the text
$badgeBottomSample = 202 # clean wood below the text
$badgeY1 = 118; $badgeY2 = 192
for ($x = $badgeLeft; $x -le $badgeRight; $x++) {
  $top = $bmp.GetPixel($x, $badgeTopSample)
  $bot = $bmp.GetPixel($x, $badgeBottomSample)
  for ($y = $badgeY1; $y -le $badgeY2; $y++) {
    $t = ($y - $badgeTopSample) / [double]($badgeBottomSample - $badgeTopSample)
    $r = [int]($top.R + ($bot.R - $top.R) * $t + ($rng.Next(5) - 2))
    $g = [int]($top.G + ($bot.G - $top.G) * $t + ($rng.Next(5) - 2))
    $b = [int]($top.B + ($bot.B - $top.B) * $t + ($rng.Next(5) - 2))
    $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $r, $g, $b))
  }
}
# Feather the region's top and bottom seams (blend 3 rows each side).
foreach ($ya in @(($badgeY1 - 3), ($badgeY2 - 3))) {
  $yb = $ya + 6
  for ($x = $badgeLeft; $x -le $badgeRight; $x++) {
    $pa = $bmp.GetPixel($x, $ya); $pb = $bmp.GetPixel($x, $yb)
    for ($i = 1; $i -lt 6; $i++) {
      $t = $i / 6.0
      $bmp.SetPixel($x, $ya + $i, [System.Drawing.Color]::FromArgb(255,
        [int]($pa.R + ($pb.R - $pa.R) * $t), [int]($pa.G + ($pb.G - $pa.G) * $t), [int]($pa.B + ($pb.B - $pa.B) * $t)))
    }
  }
}

# --- Countdown pill content removal: rebuild the ivory between clean columns. ---
$pillSampleL = 430    # clean ivory left of the clock/text
$pillSampleR = 1250   # clean ivory right of the text
$pillX1 = 520; $pillX2 = 1160
$pillY1 = 556; $pillY2 = 668
for ($y = $pillY1; $y -le $pillY2; $y++) {
  $left = $bmp.GetPixel($pillSampleL, $y)
  $right = $bmp.GetPixel($pillSampleR, $y)
  for ($x = $pillX1; $x -le $pillX2; $x++) {
    $t = ($x - $pillSampleL) / [double]($pillSampleR - $pillSampleL)
    $r = [int]($left.R + ($right.R - $left.R) * $t + ($rng.Next(5) - 2))
    $g = [int]($left.G + ($right.G - $left.G) * $t + ($rng.Next(5) - 2))
    $b = [int]($left.B + ($right.B - $left.B) * $t + ($rng.Next(5) - 2))
    $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $r, $g, $b))
  }
}
# Feather the region's left and right seams.
for ($y = $pillY1; $y -le $pillY2; $y++) {
  $pl = $bmp.GetPixel($pillX1 - 3, $y); $pr = $bmp.GetPixel($pillX1 + 3, $y)
  for ($i = -2; $i -le 2; $i++) {
    $t = ($i + 2) / 4.0
    $bmp.SetPixel($pillX1 + $i, $y, [System.Drawing.Color]::FromArgb(255,
      [int]($pl.R + ($pr.R - $pl.R) * $t), [int]($pl.G + ($pr.G - $pl.G) * $t), [int]($pl.B + ($pr.B - $pl.B) * $t)))
  }
  $pl = $bmp.GetPixel($pillX2 - 3, $y); $pr = $bmp.GetPixel($pillX2 + 3, $y)
  for ($i = -2; $i -le 2; $i++) {
    $t = ($i + 2) / 4.0
    $bmp.SetPixel($pillX2 + $i, $y, [System.Drawing.Color]::FromArgb(255,
      [int]($pl.R + ($pr.R - $pl.R) * $t), [int]($pl.G + ($pr.G - $pl.G) * $t), [int]($pl.B + ($pr.B - $pl.B) * $t)))
  }
}

$out = Join-Path $UiDir 'question-card.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)

# --- Verification: cleaned regions hold no text/glyph pixels, corners stay transparent. ---
$darkInBadge = 0; $darkInPill = 0
for ($x = $badgeLeft; $x -le $badgeRight; $x += 2) {
  for ($y = $badgeY1; $y -le $badgeY2; $y += 2) {
    $p = $bmp.GetPixel($x, $y)
    if ((0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B) -lt 60) { $darkInBadge++ }
  }
}
for ($x = $pillX1; $x -le $pillX2; $x += 2) {
  for ($y = $pillY1; $y -le $pillY2; $y += 2) {
    $p = $bmp.GetPixel($x, $y)
    if ((0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B) -lt 120) { $darkInPill++ }
  }
}
$bmp.Dispose()
$chk = [System.Drawing.Bitmap]::FromFile($out)
Write-Output ("{0}: {1}x{2} cornersAlpha={3},{4},{5},{6} darkInBadge={7} darkInPill={8}" -f `
  (Split-Path -Leaf $out), $chk.Width, $chk.Height,
  $chk.GetPixel(0, 0).A, $chk.GetPixel($chk.Width - 1, 0).A,
  $chk.GetPixel(0, $chk.Height - 1).A, $chk.GetPixel($chk.Width - 1, $chk.Height - 1).A,
  $darkInBadge, $darkInPill)
$chk.Dispose()
Write-Output 'done'
