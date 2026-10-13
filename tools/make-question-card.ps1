# Word Slice — question-card artwork generator (design reference: uploaded photo).
# Reconstructs the uploaded card design as clean, text-free PNG assets with a
# genuinely transparent exterior:
#   assets/ui/question-card.png         (full introduction card, 560x300 @2x)
#   assets/ui/question-card-compact.png (top banner frame,   560x88  @2x)
# Layered design: wooden outer frame (grain) -> teal band -> gold trim ->
# cream parchment (watermarks) -> blank riveted badge, recessed countdown
# pill, wooden progress-bar holder with empty track -> leaf clusters on all
# four corners plus gold side sprigs. No baked-in text anywhere.
# Run:  powershell -ExecutionPolicy Bypass -File tools/make-question-card.ps1
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$UiDir = Join-Path $Root 'assets\ui'
$Scale = 2

function Color-Hex([string]$Hex, [int]$Alpha = 255) {
  $h = $Hex.TrimStart('#')
  [System.Drawing.Color]::FromArgb($Alpha, [Convert]::ToInt32($h.Substring(0,2),16), [Convert]::ToInt32($h.Substring(2,2),16), [Convert]::ToInt32($h.Substring(4,2),16))
}

function New-RoundRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  $p
}

function New-VBrush([single]$x, [single]$y, [single]$w, [single]$h, [string]$topHex, [string]$bottomHex, [int]$topA = 255, [int]$botA = 255) {
  $rect = New-Object System.Drawing.RectangleF($x, $y, $w, $h)
  New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, (Color-Hex $topHex $topA), (Color-Hex $bottomHex $botA), 90.0)
}

# A pointed leaf drawn from its base at (0,0) toward +x.
function Draw-Leaf($g, [float]$s, [string]$lightHex = '#8fd44f', [string]$darkHex = '#3c9b2d', [int]$alpha = 255) {
  $leaf = New-Object System.Drawing.Drawing2D.GraphicsPath
  $leaf.AddBezier(0, 0, ($s * 0.30), (-$s * 0.52), ($s * 0.78), (-$s * 0.50), $s, 0)
  $leaf.AddBezier($s, 0, ($s * 0.78), ($s * 0.50), ($s * 0.30), ($s * 0.52), 0, 0)
  $bladeRect = New-Object System.Drawing.RectangleF(0, (-$s * 0.58), $s, ($s * 1.16))
  $blade = New-Object System.Drawing.Drawing2D.LinearGradientBrush($bladeRect, (Color-Hex $lightHex $alpha), (Color-Hex $darkHex $alpha), 0.0)
  $g.FillPath($blade, $leaf)
  $vein = New-Object System.Drawing.Drawing2D.GraphicsPath
  $vein.AddBezier(($s * 0.07), 0, ($s * 0.38), (-$s * 0.07), ($s * 0.68), ($s * 0.07), ($s * 0.93), 0)
  $g.DrawPath((New-Object System.Drawing.Pen((Color-Hex '#2c6b1d' ([int]($alpha * 0.65))), 1.5)), $vein)
  $g.DrawPath((New-Object System.Drawing.Pen((Color-Hex '#2c6b1d' ([int]($alpha * 0.55))), 1.1)), $leaf)
}

function New-CardCanvas([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap ($w * $Scale), ($h * $Scale)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.ScaleTransform($Scale, $Scale)
  @{ Bitmap = $bmp; G = $g; W = $w; H = $h }
}

# Wooden outer frame with grain -> teal band -> gold trim -> parchment.
function Draw-Frame($c) {
  $g = $c.G; $w = $c.W; $h = $c.H
  # wooden outer frame
  $wood = New-RoundRect 0 0 $w $h 24
  $g.FillPath((New-VBrush 0 0 $w $h '#9a6229' '#7a4a1e'), $wood)
  $state = $g.Save()
  $g.Clip = New-Object System.Drawing.Region($wood)
  # wood grain streaks (subtle light/dark bands)
  for ($y = 3; $y -lt $h; $y += 6) {
    $g.DrawLine((New-Object System.Drawing.Pen((Color-Hex '#5c3410' 26), 2.0)), 4, [single]$y, ($w - 4), [single]($y + 2))
    $g.DrawLine((New-Object System.Drawing.Pen((Color-Hex '#ffd9a0' 16), 1.4)), 4, [single]($y + 3), ($w - 4), [single]($y + 5))
  }
  $g.Restore($state)
  # soft outer edge light (top) / dark (bottom)
  $g.DrawPath((New-Object System.Drawing.Pen((Color-Hex '#ffe2b0' 90), 2.0)), (New-RoundRect 1.5 1.5 ($w - 3) ($h - 3) 22.5))
  $g.DrawPath((New-Object System.Drawing.Pen((Color-Hex '#3c2410' 120), 2.0)), (New-RoundRect 2.5 3 ($w - 5) ($h - 5) 22))
  # teal band
  $teal = New-RoundRect 14 14 ($w - 28) ($h - 28) 15
  $g.FillPath((New-VBrush 14 14 ($w - 28) ($h - 28) '#266a5f' '#14433c'), $teal)
  $g.DrawPath((New-Object System.Drawing.Pen((Color-Hex '#0d2f2a' 150), 1.5)), $teal)
  $g.DrawPath((New-Object System.Drawing.Pen((Color-Hex '#bfece2' 55), 1.5)), (New-RoundRect 15.5 15.5 ($w - 31) ($h - 31) 13.5))
  # gold trim ringing the parchment
  $g.DrawPath((New-Object System.Drawing.Pen((Color-Hex '#e9a83c'), 2.5)), (New-RoundRect 22 22 ($w - 44) ($h - 44) 11))
  $g.DrawPath((New-Object System.Drawing.Pen((Color-Hex '#fff0c8' 130), 1.0)), (New-RoundRect 21 21 ($w - 42) ($h - 42) 12))
  # parchment face with mottled blotches + inner shadow
  $parch = New-RoundRect 27 27 ($w - 54) ($h - 54) 9
  $g.FillPath((New-VBrush 27 27 ($w - 54) ($h - 54) '#f8efda' '#f1e3bf'), $parch)
  $state = $g.Save()
  $g.Clip = New-Object System.Drawing.Region($parch)
  $blotch = New-Object System.Drawing.SolidBrush((Color-Hex '#d9c294' 22))
  $rng = New-Object System.Random(7)
  for ($i = 0; $i -lt 14; $i++) {
    $bx = 30 + $rng.Next([int]($w - 80)); $by = 30 + $rng.Next([int]($h - 70))
    $g.FillEllipse($blotch, [single]$bx, [single]$by, [single](18 + $rng.Next(26)), [single](8 + $rng.Next(12)))
  }
  $g.Restore($state)
  $g.DrawPath((New-Object System.Drawing.Pen((Color-Hex '#c9ac74' 160), 2.0)), (New-RoundRect 28.5 28.5 ($w - 57) ($h - 57) 8))
  $g.DrawPath((New-Object System.Drawing.Pen((Color-Hex '#ffffff' 120), 1.2)), (New-RoundRect 29.5 29.5 ($w - 59) ($h - 59) 7))
}

# Leaf cluster helper: caller positions/rotates per corner.
function Draw-LeafCluster($g, [float]$s1, [float]$s2, [float]$rot1, [float]$rot2, [single]$dx2, [single]$dy2) {
  Draw-Leaf $g $s1
  $g.TranslateTransform($dx2, $dy2); $g.RotateTransform($rot2 - $rot1)
  Draw-Leaf $g $s2
  $g.RotateTransform(-($rot2 - $rot1)); $g.TranslateTransform(-$dx2, -$dy2)
}

# Gold sprig: three small gold leaves fanned from one point.
function Draw-Sprig($g, [float]$s) {
  Draw-Leaf $g $s '#e7c27a' '#b3813a'
  $g.RotateTransform(38); Draw-Leaf $g ($s * 0.8) '#e7c27a' '#b3813a'; $g.RotateTransform(-38)
  $g.RotateTransform(-34); Draw-Leaf $g ($s * 0.8) '#e7c27a' '#b3813a'; $g.RotateTransform(34)
}

# ---------------- Introduction card (560x300) ----------------
$card = New-CardCanvas 560 300
$g = $card.G
Draw-Frame $card

# Parchment watermarks: faint tan leaves at the lower corners.
$g.TranslateTransform(64, 258); $g.RotateTransform(28); Draw-Leaf $g 22 '#e3d3a8' '#cbb47e' 90
$g.ResetTransform(); $g.ScaleTransform($Scale, $Scale)
$g.TranslateTransform(496, 258); $g.ScaleTransform(-1, 1); $g.RotateTransform(28); Draw-Leaf $g 22 '#e3d3a8' '#cbb47e' 90
$g.ResetTransform(); $g.ScaleTransform($Scale, $Scale)

# Blank riveted wooden badge overlapping the top frame, centered.
$shadow = New-Object System.Drawing.SolidBrush((Color-Hex '#2a1607' 70))
$g.FillPath($shadow, (New-RoundRect 161 10 240 36 18))
$badge = New-RoundRect 160 7 240 36 18
$g.FillPath((New-VBrush 160 7 240 36 '#6e4420' '#53300f'), $badge)
$g.DrawPath((New-Object System.Drawing.Pen((Color-Hex '#e9a83c'), 2.0)), $badge)
$g.FillPath((New-VBrush 163 9 234 14 '#ffd9a0' '#ffd9a0' 60 0), (New-RoundRect 163 9 234 14 12))
foreach ($rx in @(176, 384)) {
  $g.FillEllipse((New-Object System.Drawing.SolidBrush((Color-Hex '#ffd060'))), ($rx - 3.4), 18.2, 6.8, 6.8)
  $g.DrawEllipse((New-Object System.Drawing.Pen((Color-Hex '#7a4a10'), 1.0)), ($rx - 3.4), 18.2, 6.8, 6.8)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush((Color-Hex '#fff2c8' 220))), ($rx - 1.6), 19.6, 2.0, 2.0)
}

# Blank recessed countdown pill.
$pill = New-RoundRect 165 209 230 40 20
$g.FillPath((New-VBrush 165 209 230 40 '#fbf3dc' '#f3e6c2'), $pill)
$g.DrawPath((New-Object System.Drawing.Pen((Color-Hex '#c9ac74' 150), 1.5)), $pill)
$g.DrawLine((New-Object System.Drawing.Pen((Color-Hex '#8a6a35' 70), 2.0)), 172, 212.5, 388, 212.5)
$g.DrawLine((New-Object System.Drawing.Pen((Color-Hex '#ffffff' 150), 1.2)), 172, 246, 388, 246)

# Wooden progress-bar holder with an empty track.
$g.FillPath($shadow, (New-RoundRect 112 264 340 26 13))
$bar = New-RoundRect 110 260 340 26 13
$g.FillPath((New-VBrush 110 260 340 26 '#6e4420' '#53300f'), $bar)
$g.DrawPath((New-Object System.Drawing.Pen((Color-Hex '#e9a83c'), 1.6)), $bar)
$g.FillPath((New-VBrush 113 262 334 9 '#ffd9a0' '#ffd9a0' 45 0), (New-RoundRect 113 262 334 9 8))
$track = New-RoundRect 124 267 312 12 6
$g.FillPath((New-Object System.Drawing.SolidBrush((Color-Hex '#3f2a10'))), $track)
$g.DrawLine((New-Object System.Drawing.Pen((Color-Hex '#000000' 90), 1.6)), 130, 269.5, 430, 269.5)

# Leaf clusters on all four corners + gold side sprigs.
$g.TranslateTransform(16, 14); $g.RotateTransform(-42); Draw-LeafCluster $g 30 21 -42 -14 20 -5
$g.ResetTransform(); $g.ScaleTransform($Scale, $Scale)
$g.TranslateTransform(544, 14); $g.ScaleTransform(-1, 1); $g.RotateTransform(-42); Draw-LeafCluster $g 30 21 -42 -14 20 -5
$g.ResetTransform(); $g.ScaleTransform($Scale, $Scale)
$g.TranslateTransform(16, 288); $g.RotateTransform(138); Draw-LeafCluster $g 27 19 138 164 18 4
$g.ResetTransform(); $g.ScaleTransform($Scale, $Scale)
$g.TranslateTransform(544, 288); $g.ScaleTransform(-1, 1); $g.RotateTransform(138); Draw-LeafCluster $g 27 19 138 164 18 4
$g.ResetTransform(); $g.ScaleTransform($Scale, $Scale)
$g.TranslateTransform(4, 158); $g.RotateTransform(-8); Draw-Sprig $g 14
$g.ResetTransform(); $g.ScaleTransform($Scale, $Scale)
$g.TranslateTransform(556, 158); $g.ScaleTransform(-1, 1); $g.RotateTransform(-8); Draw-Sprig $g 14
$g.ResetTransform(); $g.ScaleTransform($Scale, $Scale)

$outIntro = Join-Path $UiDir 'question-card.png'
$card.Bitmap.Save($outIntro, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $card.Bitmap.Dispose()

# ---------------- Compact banner frame (560x88) ----------------
$banner = New-CardCanvas 560 88
$gb = $banner.G
# Same layering, proportionally tighter.
$wood = New-RoundRect 0 0 560 88 20
$gb.FillPath((New-VBrush 0 0 560 88 '#9a6229' '#7a4a1e'), $wood)
$st = $gb.Save()
$gb.Clip = New-Object System.Drawing.Region($wood)
for ($y = 2; $y -lt 88; $y += 6) {
  $gb.DrawLine((New-Object System.Drawing.Pen((Color-Hex '#5c3410' 26), 2.0)), 3, [single]$y, 557, [single]($y + 2))
  $gb.DrawLine((New-Object System.Drawing.Pen((Color-Hex '#ffd9a0' 16), 1.4)), 3, [single]($y + 3), 557, [single]($y + 5))
}
$gb.Restore($st)
$gb.DrawPath((New-Object System.Drawing.Pen((Color-Hex '#ffe2b0' 90), 2.0)), (New-RoundRect 1.5 1.5 557 85 18.5))
$gb.DrawPath((New-Object System.Drawing.Pen((Color-Hex '#3c2410' 120), 2.0)), (New-RoundRect 2.5 3 555 83 18))
$teal2 = New-RoundRect 9 9 542 70 12
$gb.FillPath((New-VBrush 9 9 542 70 '#266a5f' '#14433c'), $teal2)
$gb.DrawPath((New-Object System.Drawing.Pen((Color-Hex '#0d2f2a' 150), 1.2)), $teal2)
$gb.DrawPath((New-Object System.Drawing.Pen((Color-Hex '#e9a83c'), 2.2)), (New-RoundRect 14 14 532 60 9))
$parch2 = New-RoundRect 18 18 524 52 7
$gb.FillPath((New-VBrush 18 18 524 52 '#f8efda' '#f1e3bf'), $parch2)
$gb.DrawPath((New-Object System.Drawing.Pen((Color-Hex '#c9ac74' 160), 1.6)), (New-RoundRect 19 19 522 50 6))
$gb.TranslateTransform(12, 10); $gb.RotateTransform(-40); Draw-LeafCluster $gb 22 16 -40 -12 14 -3
$gb.ResetTransform(); $gb.ScaleTransform($Scale, $Scale)
$gb.TranslateTransform(548, 10); $gb.ScaleTransform(-1, 1); $gb.RotateTransform(-40); Draw-LeafCluster $gb 22 16 -40 -12 14 -3
$gb.ResetTransform(); $gb.ScaleTransform($Scale, $Scale)
$gb.TranslateTransform(12, 80); $gb.RotateTransform(140); Draw-Leaf $gb 18
$gb.ResetTransform(); $gb.ScaleTransform($Scale, $Scale)
$gb.TranslateTransform(548, 80); $gb.ScaleTransform(-1, 1); $gb.RotateTransform(140); Draw-Leaf $gb 18
$gb.ResetTransform(); $gb.ScaleTransform($Scale, $Scale)

$outCompact = Join-Path $UiDir 'question-card-compact.png'
$banner.Bitmap.Save($outCompact, [System.Drawing.Imaging.ImageFormat]::Png)
$gb.Dispose(); $banner.Bitmap.Dispose()

# ---------------- Alpha verification ----------------
foreach ($f in @($outIntro, $outCompact)) {
  $chk = [System.Drawing.Bitmap]::FromFile($f)
  $corners = @(
    $chk.GetPixel(0, 0).A, $chk.GetPixel($chk.Width - 1, 0).A,
    $chk.GetPixel(0, $chk.Height - 1).A, $chk.GetPixel($chk.Width - 1, $chk.Height - 1).A
  )
  $centerA = $chk.GetPixel([int]($chk.Width / 2), [int]($chk.Height / 2)).A
  Write-Output ("{0}: {1}x{2} cornersAlpha={3} centerAlpha={4}" -f (Split-Path -Leaf $f), $chk.Width, $chk.Height, ($corners -join ','), $centerA)
  $chk.Dispose()
}
Write-Output 'done'
