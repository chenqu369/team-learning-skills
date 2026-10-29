param([Parameter(Mandatory=$true)][string]$JobFile)
$ErrorActionPreference = 'Stop'
$job = Get-Content -LiteralPath $JobFile -Raw -Encoding UTF8 | ConvertFrom-Json
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$hadPowerPoint = @(Get-Process POWERPNT -ErrorAction SilentlyContinue).Count -gt 0
$application = $null
$presentation = $null
function Check-CertificateCancellation {
    if ($job.cancel_file -and (Test-Path -LiteralPath $job.cancel_file)) {
        throw 'Certificate export cancelled; closing this presentation'
    }
}
try {
    $application = New-Object -ComObject PowerPoint.Application
    $application.DisplayAlerts = 1
    $presentation = $application.Presentations.Open([string]$job.template, -1, -1, 0)
    if ($presentation.Slides.Count -ne 1) { throw 'The certificate template must have exactly one slide' }
    $first = $presentation.Slides.Item(1)
    $xScale = [double]$presentation.PageSetup.SlideWidth / [double]$job.width
    $yScale = [double]$presentation.PageSetup.SlideHeight / [double]$job.height
    if ([Math]::Abs($xScale-$yScale) -gt 0.0001) { throw 'Template aspect ratio differs from output dimensions' }
    if ($job.template_only) {
        $presentation.SaveAs([string]$job.output_pptx, 24)
        @{ok=$true;template=$job.output_pptx;elapsed_seconds=$clock.Elapsed.TotalSeconds} | ConvertTo-Json -Compress
    } else {
        $checks = @()
        $fillStart = $clock.Elapsed.TotalSeconds
        for ($rowIndex=0; $rowIndex -lt $job.rows.Count; $rowIndex++) {
            Check-CertificateCancellation
            $row = $job.rows[$rowIndex]
            if ($rowIndex -eq 0) { $slide = $first }
            else {
                $copy = $first.Duplicate()
                $slide = $copy.Item(1)
                $slide.MoveTo($presentation.Slides.Count)
            }
            $bounds = @{}
            foreach ($field in @('name','course','role','date','number')) {
                $shape = $slide.Shapes.Item('cert.'+$field)
                $shape.TextFrame2.AutoSize = 0
                $shape.TextFrame2.WordWrap = 0
                $shape.TextFrame2.MarginLeft = 0
                $shape.TextFrame2.MarginRight = 0
                $shape.TextFrame2.MarginTop = 0
                $shape.TextFrame2.MarginBottom = 0
                $shape.Left = [single]([double]$job.layout.$field.xy[0] * $xScale)
                $shape.Top = [single]([double]$job.layout.$field.xy[1] * $yScale)
                $shape.Width = [single]([double]$job.layout.$field.max_width * $xScale)
                $shape.Height = [single]([double]$job.layout.$field.size * $yScale * 1.8)
                $shape.TextFrame.TextRange.Text = [string]$row.fields.$field
                $shape.TextFrame.TextRange.Font.Name = [string]$job.font_family
                $shape.TextFrame.TextRange.Font.NameFarEast = [string]$job.font_family
                $shape.TextFrame.TextRange.Font.Size = [double]$job.layout.$field.size * $xScale
                $color = @(60,60,60)
                if ($null -ne $job.layout.$field.fill) { $color = $job.layout.$field.fill }
                $shape.TextFrame.TextRange.Font.Color.RGB = [int]($color[0]+$color[1]*256+$color[2]*65536)
                $textRange = $shape.TextFrame2.TextRange
                $left = [double]$textRange.BoundLeft / $xScale
                $top = [double]$textRange.BoundTop / $yScale
                $right = $left + [double]$textRange.BoundWidth / $xScale
                $bottom = $top + [double]$textRange.BoundHeight / $yScale
                if ($left -lt -1 -or $top -lt -1 -or $right -gt ([double]$job.width+1) -or $bottom -gt ([double]$job.height+1) -or ($right-$left) -gt ([double]$job.layout.$field.max_width+1)) {
                    throw ('PPT text exceeds configured bounds: '+$row.number+' / '+$field)
                }
                $bounds[$field] = @($left,$top,$right,$bottom)
                $null = [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($textRange)
                $null = [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shape)
            }
            $checks += @{key=$row.key;number=$row.number;bounds=$bounds}
        }
        $fillSeconds = $clock.Elapsed.TotalSeconds-$fillStart
        $presentation.SaveAs([string]$job.output_pptx, 24)
        $exportStart = $clock.Elapsed.TotalSeconds
        for ($rowIndex=0; $rowIndex -lt $job.rows.Count; $rowIndex++) {
            Check-CertificateCancellation
            $row = $job.rows[$rowIndex]
            $null = New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName([string]$row.png_path)) -Force
            $slide = $presentation.Slides.Item($rowIndex+1)
            $slide.Export([string]$row.png_path,'PNG',[int]$job.width,[int]$job.height)
        }
        $report = @{ok=$true;slide_count=$presentation.Slides.Count;checks=$checks;fill_seconds=$fillSeconds;export_seconds=($clock.Elapsed.TotalSeconds-$exportStart);powerpoint_seconds=$clock.Elapsed.TotalSeconds;direct_llm_requests=0}
        $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $job.report -Encoding UTF8
        @{ok=$true;slide_count=$presentation.Slides.Count;powerpoint_seconds=$clock.Elapsed.TotalSeconds} | ConvertTo-Json -Compress
    }
} finally {
    if ($presentation) { $presentation.Close(); $null = [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation) }
    if ($application) {
        if (-not $hadPowerPoint -and $application.Presentations.Count -eq 0) { $application.Quit() }
        $null = [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($application)
    }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}
