Add-Type -AssemblyName System.Drawing

$bgColor     = [System.Drawing.Color]::FromArgb(8, 17, 12)      # #08110c
$gridColor   = [System.Drawing.Color]::FromArgb(16, 34, 24)     # faint grid lines
$accent      = [System.Drawing.Color]::FromArgb(107, 237, 153)  # #6BED99
$accentDim   = [System.Drawing.Color]::FromArgb(60, 120, 85)
$dim         = [System.Drawing.Color]::FromArgb(90, 130, 105)

function New-GridBitmap([int]$w, [int]$h, [int]$step) {
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $bgBrush = New-Object System.Drawing.SolidBrush($bgColor)
    $g.FillRectangle($bgBrush, 0, 0, $w, $h)
    $gridPen = New-Object System.Drawing.Pen($gridColor, 1)
    for ($x = 0; $x -lt $w; $x += $step) { $g.DrawLine($gridPen, $x, 0, $x, $h) }
    for ($y = 0; $y -lt $h; $y += $step) { $g.DrawLine($gridPen, 0, $y, $w, $y) }
    return @{ Bitmap = $bmp; Graphics = $g }
}

function Save-Bmp24([System.Drawing.Bitmap]$bmp, [string]$path) {
    $clean = New-Object System.Drawing.Bitmap($bmp.Width, $bmp.Height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g2 = [System.Drawing.Graphics]::FromImage($clean)
    $g2.DrawImage($bmp, 0, 0)
    $g2.Dispose()
    $clean.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $clean.Dispose()
}

# ---- Sidebar (welcome/finish) bitmap: 164x314 ----
$w = 164; $h = 314
$ctx = New-GridBitmap $w $h 22
$bmp = $ctx.Bitmap
$g = $ctx.Graphics

# top accent line
$accentPen = New-Object System.Drawing.Pen($accent, 3)
$g.DrawLine($accentPen, 0, 96, $w, 96)

# small filled square "mark" above the line
$markBrush = New-Object System.Drawing.SolidBrush($accent)
$g.FillRectangle($markBrush, 22, 56, 14, 14)
$dimBrush = New-Object System.Drawing.SolidBrush($accentDim)
$g.FillRectangle($dimBrush, 40, 56, 14, 14)
$g.FillRectangle($markBrush, 22, 74, 14, 14)

# wordmark
$titleFont = New-Object System.Drawing.Font("Consolas", 19, [System.Drawing.FontStyle]::Bold)
$titleBrush = New-Object System.Drawing.SolidBrush($accent)
$g.DrawString("RECHARGE", $titleFont, $titleBrush, 20, 116)

# subtitle
$subFont = New-Object System.Drawing.Font("Consolas", 9, [System.Drawing.FontStyle]::Regular)
$subBrush = New-Object System.Drawing.SolidBrush($dim)
$g.DrawString("IGTAP MOD", $subFont, $subBrush, 20, 150)
$g.DrawString("MANAGER", $subFont, $subBrush, 20, 165)

# bottom hint text
$hintFont = New-Object System.Drawing.Font("Consolas", 8, [System.Drawing.FontStyle]::Regular)
$hintBrush = New-Object System.Drawing.SolidBrush($accentDim)
$g.DrawString("codecade.co.za/recharge", $hintFont, $hintBrush, 12, $h - 24)

Save-Bmp24 $bmp "D:\Scripts\rust\Recharge\installer\assets\welcome.bmp"
$g.Dispose(); $bmp.Dispose()

# ---- Header bitmap: 150x57 ----
$w2 = 150; $h2 = 57
$ctx2 = New-GridBitmap $w2 $h2 16
$bmp2 = $ctx2.Bitmap
$g2 = $ctx2.Graphics

$markBrush2 = New-Object System.Drawing.SolidBrush($accent)
$g2.FillRectangle($markBrush2, 10, 18, 10, 10)
$dimBrush2 = New-Object System.Drawing.SolidBrush($accentDim)
$g2.FillRectangle($dimBrush2, 22, 18, 10, 10)
$g2.FillRectangle($markBrush2, 10, 30, 10, 10)

$hFont = New-Object System.Drawing.Font("Consolas", 12, [System.Drawing.FontStyle]::Bold)
$hBrush = New-Object System.Drawing.SolidBrush($accent)
$g2.DrawString("RECHARGE", $hFont, $hBrush, 40, 18)

Save-Bmp24 $bmp2 "D:\Scripts\rust\Recharge\installer\assets\header.bmp"
$g2.Dispose(); $bmp2.Dispose()

Write-Host "Generated welcome.bmp and header.bmp"
