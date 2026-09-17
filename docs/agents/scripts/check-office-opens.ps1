$ErrorActionPreference = "Stop"
$dir = "C:\Users\bishi\AppData\Local\Temp\claude-session-files\office-check"

function Try-Word {
  $app = New-Object -ComObject Word.Application
  $app.Visible = $false; $app.DisplayAlerts = 0
  try {
    $doc = $app.Documents.Open("$dir\check.docx", $false, $true)
    $text = $doc.Content.Text
    Write-Output ("WORD ok | paragraphs " + $doc.Paragraphs.Count + " | tables " + $doc.Tables.Count)
    Write-Output ("WORD text: " + ($text -replace "[\r\n\a]+", " ").Substring(0, [Math]::Min(120, $text.Length)))
    $doc.Close($false)
  } finally { $app.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
}
function Try-Excel {
  $app = New-Object -ComObject Excel.Application
  $app.Visible = $false; $app.DisplayAlerts = $false
  try {
    $wb = $app.Workbooks.Open("$dir\check.xlsx", 0, $true)
    $ws = $wb.Worksheets.Item(1)
    Write-Output ("EXCEL ok | sheets " + $wb.Worksheets.Count + " | name " + $ws.Name)
    Write-Output ("EXCEL A1=" + $ws.Range("A1").Text + " B2=" + $ws.Range("B2").Text + " B3formula=" + $ws.Range("B3").Formula + " B3value=" + $ws.Range("B3").Text)
    $wb.Close($false)
  } finally { $app.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
}
function Try-PowerPoint {
  $app = New-Object -ComObject PowerPoint.Application
  try {
    $pres = $app.Presentations.Open("$dir\check.pptx", $true, $false, $false)
    Write-Output ("PPT ok | slides " + $pres.Slides.Count)
    $s1 = $pres.Slides.Item(1)
    Write-Output ("PPT slide1 shapes " + $s1.Shapes.Count + " | title " + $s1.Shapes.Item(1).TextFrame.TextRange.Text)
    $pres.Close()
  } finally { $app.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
}
foreach ($f in @('Try-Word','Try-Excel','Try-PowerPoint')) {
  try { & $f } catch { Write-Output ($f + " FAILED: " + $_.Exception.Message) }
}
