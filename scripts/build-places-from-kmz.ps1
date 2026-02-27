param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,

  [string]$OutputPath = ".\web\data\places.json"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Web

function Read-KmlText([string]$path) {
  $ext = [System.IO.Path]::GetExtension($path).ToLowerInvariant()
  if ($ext -eq ".kmz") {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $temp = New-TemporaryFile
    Remove-Item $temp
    $temp = "$temp.zip"
    Copy-Item -LiteralPath $path -Destination $temp -Force
    $zip = [System.IO.Compression.ZipFile]::OpenRead($temp)
    try {
      $entry = $zip.Entries | Where-Object { $_.FullName -eq "doc.kml" } | Select-Object -First 1
      if (-not $entry) {
        throw "KMZ 안에 doc.kml이 없습니다."
      }
      $reader = New-Object System.IO.StreamReader($entry.Open())
      try { return $reader.ReadToEnd() } finally { $reader.Close(); $reader.Dispose() }
    } finally {
      $zip.Dispose()
      Remove-Item -LiteralPath $temp -Force
    }
  }

  return Get-Content -LiteralPath $path -Raw -Encoding UTF8
}

function Parse-TimeSeconds([string]$raw) {
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return $null
  }

  $value = $raw.Trim().ToLowerInvariant()
  if ($value -match '^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$') {
    $h = if ($matches[1]) { [int]$matches[1] } else { 0 }
    $m = if ($matches[2]) { [int]$matches[2] } else { 0 }
    $s = if ($matches[3]) { [int]$matches[3] } else { 0 }
    return $h * 3600 + $m * 60 + $s
  }

  if ($value -match '^\d+$') {
    return [int]$value
  }

  return $null
}

function SecondsToLabel([int]$seconds) {
  $m = [int][Math]::Floor($seconds / 60)
  $s = $seconds % 60
  return "{0}:{1:00}" -f $m, $s
}

function Resolve-YouTube([string]$description) {
  if ([string]::IsNullOrWhiteSpace($description)) {
    return @{ url = $null; id = $null; start = $null; label = $null }
  }

  if (-not ($description -match 'https?:\/\/[^\s"<>]+')) {
    return @{ url = $null; id = $null; start = $null; label = $null }
  }

  $urlText = $matches[0]
  $urlText = $urlText -replace '[)\]]+$', ''
  try {
    $uri = [Uri]$urlText
  } catch {
    return @{ url = $urlText; id = $null; start = $null; label = $null }
  }

  $id = $null
  if ($uri.Host -eq "youtu.be") {
    $id = $uri.AbsolutePath.Trim("/")
  } elseif ($uri.AbsolutePath -match "^/watch$") {
    $query = [System.Web.HttpUtility]::ParseQueryString($uri.Query)
    $id = $query["v"]
  } elseif ($uri.AbsolutePath -match "^/embed/([^/?]+)") {
    $id = $matches[1]
  }

  if ([string]::IsNullOrWhiteSpace($id)) {
    return @{ url = $urlText; id = $null; start = $null; label = $null }
  }

  $query = [System.Web.HttpUtility]::ParseQueryString($uri.Query)
  $startRaw = $query["t"]
  if ([string]::IsNullOrWhiteSpace($startRaw)) {
    $startRaw = $query["start"]
  }
  if ([string]::IsNullOrWhiteSpace($startRaw)) {
    $startRaw = $query["time_continue"]
  }
  $cleanQuery = [System.Web.HttpUtility]::ParseQueryString("")
  foreach ($key in $query.AllKeys) {
    if ($key -in @("t", "start", "time_continue")) {
      continue
    }
    $null = $cleanQuery.Add($key, $query[$key])
  }
  $builder = New-Object System.UriBuilder($uri)
  $builder.Query = $cleanQuery.ToString()
  $urlText = $builder.Uri.AbsoluteUri

  $start = Parse-TimeSeconds -raw $startRaw
  $label = if ($start -ne $null) { SecondsToLabel -seconds $start } else { $null }

  return @{
    url = $urlText
    id = $id
    start = $start
    label = $label
  }
}

function Collect-Places([System.Xml.XmlElement]$node, [string]$category, [System.Xml.XmlNamespaceManager]$ns) {
  $items = @()

  $nameNode = $node.SelectSingleNode("k:name", $ns)
  $nodeName = if ($nameNode) { $nameNode.InnerText } else { "" }
  $currentCategory = if ([string]::IsNullOrWhiteSpace($category)) { $nodeName } elseif ([string]::IsNullOrWhiteSpace($nodeName)) { $category } else { "$category · $nodeName" }

  foreach ($placemark in $node.SelectNodes("k:Placemark", $ns)) {
    $nameNode = $placemark.SelectSingleNode("k:name", $ns)
    $descNode = $placemark.SelectSingleNode("k:description", $ns)
    $coordNode = $placemark.SelectSingleNode(".//k:coordinates", $ns)
    $name = if ($nameNode) { $nameNode.InnerText } else { "이름 없음" }
    $description = if ($descNode) { $descNode.InnerText } else { "" }
    $coordText = if ($coordNode) { $coordNode.InnerText } else { "" }
    if ([string]::IsNullOrWhiteSpace($coordText)) {
      continue
    }

    $parts = $coordText.Trim().Split(",")
    if ($parts.Length -lt 2) {
      continue
    }

    $lonParsed = 0.0
    $latParsed = 0.0
    $okLon = [double]::TryParse($parts[0].Trim(), [ref]$lonParsed)
    $okLat = [double]::TryParse($parts[1].Trim(), [ref]$latParsed)
    if (-not ($okLon -and $okLat)) {
      continue
    }

    $yt = Resolve-YouTube -description $description
    $items += [pscustomobject]@{
      id = "$name ($($parts[1]),$($parts[0]))"
      category = $currentCategory
      name = $name
      description = $description
      lat = $latParsed
      lon = $lonParsed
      youtubeUrl = $yt.url
      youtubeId = $yt.id
      youtubeStart = $yt.start
      youtubeStartLabel = $yt.label
    }
  }

  foreach ($child in $node.SelectNodes("k:Folder", $ns)) {
    $items += Collect-Places -node $child -category $currentCategory -ns $ns
  }

  return $items
}

$kmlText = Read-KmlText -path $InputPath
$xml = New-Object System.Xml.XmlDocument
$xml.LoadXml($kmlText)
$ns = New-Object System.Xml.XmlNamespaceManager($xml.NameTable)
$ns.AddNamespace("k", "http://www.opengis.net/kml/2.2")

$documentNode = $xml.SelectSingleNode("//k:Document", $ns)
if (-not $documentNode) { $documentNode = $xml.DocumentElement }
$places = Collect-Places -node $documentNode -category "" -ns $ns
$places = $places | Sort-Object category, name

$fullOutputPath = (Resolve-Path -Path (Split-Path -Parent $OutputPath -ErrorAction SilentlyContinue)).Path
$root = if ([string]::IsNullOrWhiteSpace($fullOutputPath)) {
  (Get-Location).Path
} else {
  $fullOutputPath
}
if (-not (Test-Path $root)) { New-Item -ItemType Directory -Path $root -Force | Out-Null }

$json = $places | ConvertTo-Json -Depth 8
$outputAbsolutePath = (Resolve-Path -LiteralPath "." | Join-Path -ChildPath $OutputPath)
[System.IO.File]::WriteAllText($outputAbsolutePath, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Exported: $($places.Count) places -> $OutputPath"
