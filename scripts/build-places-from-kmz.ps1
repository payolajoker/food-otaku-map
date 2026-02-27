param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,

  [string]$OutputPath = ".\web\data\places.json"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Web
$YouTubeTimestampOverrides = @{
  "가쓰오 공사" = "https://youtu.be/eOuRDr4EpRE?si=3Qp_mUndCnQEJLZk&t=429"
}

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
    $hours = if ($matches[1]) { [int]$matches[1] } else { 0 }
    $minutes = if ($matches[2]) { [int]$matches[2] } else { 0 }
    $seconds = if ($matches[3]) { [int]$matches[3] } else { 0 }
    return $hours * 3600 + $minutes * 60 + $seconds
  }

  if ($value -match '^\d+$') {
    return [int]$value
  }

  return $null
}

function Parse-Episode([string]$category) {
  if ([string]::IsNullOrWhiteSpace($category)) {
    return [double]::PositiveInfinity
  }
  if ($category -match '(?i)EP\.?\s*([0-9]+(?:\.[0-9]+)?)') {
    return [double]$matches[1]
  }
  return [double]::PositiveInfinity
}

function SecondsToLabel([int]$seconds) {
  $totalMinutes = [int][Math]::Floor($seconds / 60)
  $remainingSeconds = $seconds % 60
  return "{0}:{1:00}" -f $totalMinutes, $remainingSeconds
}

function Resolve-YouTube([string]$description) {
  if ([string]::IsNullOrWhiteSpace($description)) {
    return @{ url = $null; id = $null; start = $null; label = $null }
  }

  $urlMatches = [regex]::Matches($description, 'https?:\/\/[^\s"<>]+')
  if ($urlMatches.Count -eq 0) {
    return @{ url = $null; id = $null; start = $null; label = $null }
  }

  $fallback = $null
  foreach ($urlMatch in $urlMatches) {
    $urlText = $urlMatch.Value -replace '[)\]]+$', ''
    try {
      $uri = [Uri]$urlText
    } catch {
      continue
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
      continue
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
    $cleanUrl = $builder.Uri.AbsoluteUri

    $start = Parse-TimeSeconds -raw $startRaw
    $label = if ($start -ne $null) { SecondsToLabel -seconds $start } else { $null }
    $resolved = @{
      url = $cleanUrl
      id = $id
      start = $start
      label = $label
    }

    if ($start -ne $null -and $fallback -eq $null) {
      $fallback = $resolved
      continue
    }

    if ($fallback -eq $null) {
      $fallback = $resolved
    }

    if ($start -ne $null) {
      return $resolved
    }
  }

  if ($fallback -ne $null) {
    return $fallback
  }

  return @{
    url = $null
    id = $null
    start = $null
    label = $null
  }
}

$YouTubeRequestHeaders = @{
  "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36"
  "Accept-Language" = "en-US,en;q=0.9"
}
$YouTubeStoryboardMetaCache = @{}

function Get-YouTubeStoryboardMeta {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$VideoId)

  if ([string]::IsNullOrWhiteSpace($VideoId)) {
    return $null
  }

  if ($YouTubeStoryboardMetaCache.ContainsKey($VideoId)) {
    return $YouTubeStoryboardMetaCache[$VideoId]
  }

  try {
    $watchUrl = "https://www.youtube.com/watch?v=$VideoId"
    $response = Invoke-WebRequest -Uri $watchUrl -UseBasicParsing -Headers $YouTubeRequestHeaders -TimeoutSec 20
  } catch {
    Write-Warning "Failed to load YouTube watch page for '$VideoId': $($_.Exception.Message)"
    return $null
  }

  $match = [regex]::Match($response.Content, 'ytInitialPlayerResponse\s*=\s*(\{.*?\})\s*;', [System.Text.RegularExpressions.RegexOptions]::Singleline)
  if (-not $match.Success) {
    Write-Warning "Could not locate ytInitialPlayerResponse for '$VideoId'"
    return $null
  }

  $playerResponse = $null
  try {
    $playerResponse = ConvertFrom-Json $match.Groups[1].Value
  } catch {
    Write-Warning "Failed to parse ytInitialPlayerResponse JSON for '$VideoId': $($_.Exception.Message)"
    return $null
  }

  $storyboardSpec = $playerResponse.storyboards.playerStoryboardSpecRenderer.spec
  if ([string]::IsNullOrWhiteSpace($storyboardSpec)) {
    return $null
  }

  $lengthText = [string]$playerResponse.videoDetails.lengthSeconds
  $lengthSeconds = 0
  if (-not [double]::TryParse($lengthText, [ref]$lengthSeconds)) {
    return $null
  }
  $durationSeconds = [int][Math]::Floor($lengthSeconds)

  $parts = $storyboardSpec -split '\|'
  if ($parts.Count -lt 2) {
    return $null
  }

  $baseUrl = $parts[0]
  $levels = @()
  for ($i = 1; $i -lt $parts.Count; $i++) {
    $tokens = $parts[$i] -split '#'
    if ($tokens.Count -lt 8) {
      continue
    }

    try {
      $frameWidth = [int]$tokens[0]
      $frameHeight = [int]$tokens[1]
      $frameCount = [int]$tokens[2]
      $cols = [int]$tokens[3]
      $rows = [int]$tokens[4]
      $interval = [int]$tokens[5]
    } catch {
      continue
    }

    if ($frameCount -le 0 -or $frameWidth -le 0 -or $frameHeight -le 0) {
      continue
    }
    if ($interval -le 0 -and $durationSeconds -gt 0) {
      $interval = [int](($durationSeconds / [double]$frameCount) * 1000)
    }

    $thumbnailsPerImage = [Math]::Max(1, $cols * $rows)
    $imageCount = [int][Math]::Ceiling($frameCount / [double]$thumbnailsPerImage)
    $boardName = $tokens[6]
    $signature = $tokens[$tokens.Length - 1]
    $urlTemplate = $baseUrl.Replace('$L', "$i").Replace('$N', $boardName)
    $urlTemplate = if ($urlTemplate.Contains("?")) { "$urlTemplate&sigh=$signature" } else { "$urlTemplate?sigh=$signature" }

    $levels += [pscustomobject]@{
      width = $frameWidth
      height = $frameHeight
      count = $frameCount
      columns = $cols
      rows = $rows
      interval = [Math]::Max(1, $interval)
      boardName = $boardName
      urlTemplate = $urlTemplate
      imageCount = [Math]::Max(1, $imageCount)
      thumbnailsPerImage = $thumbnailsPerImage
    }
  }

  if ($levels.Count -eq 0) {
    return $null
  }

  $meta = [pscustomobject]@{
    levels = $levels
  }
  $YouTubeStoryboardMetaCache[$VideoId] = $meta
  return $meta
}

function Test-ImageUrl {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Uri)

  try {
    $null = Invoke-WebRequest -Uri $Uri -Method Head -UseBasicParsing -Headers $YouTubeRequestHeaders -TimeoutSec 10 -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Get-YoutubeTimestampFrame {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$VideoId,
    [Parameter(Mandatory = $true)][int]$StartSeconds
  )

  $meta = Get-YouTubeStoryboardMeta -VideoId $VideoId
  if ($meta -eq $null -or -not $meta.levels) {
    return $null
  }

  $timeMs = [Math]::Max(0, $StartSeconds) * 1000
  foreach ($level in ($meta.levels | Sort-Object { $_.width * $_.height } -Descending)) {
    if ($level.count -le 0) {
      continue
    }

    $index = [int][Math]::Floor($timeMs / [double]$level.interval)
    if ($index -lt 0) {
      $index = 0
    }
    if ($index -ge $level.count) {
      $index = $level.count - 1
    }

    $boardIndex = [Math]::Max(0, [int][Math]::Floor($index / [double]$level.thumbnailsPerImage))
    if ($boardIndex -ge $level.imageCount) {
      $boardIndex = $level.imageCount - 1
    }

    $frameInBoard = $index - ($boardIndex * $level.thumbnailsPerImage)
    $row = [Math]::Floor($frameInBoard / [double]$level.columns)
    $col = $frameInBoard % $level.columns
    $url = if ($level.boardName -eq 'M$M') {
      $level.urlTemplate.Replace('M$M', "M$boardIndex")
    } else {
      $level.urlTemplate
    }

    return [pscustomobject]@{
      url = $url
      x = $col * $level.width
      y = $row * $level.height
      width = $level.width
      height = $level.height
    }
  }

  return $null
}

function Get-YouTubeTimestampOverrideFromName {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Name)

  $normalizedName = if ($Name) { $Name.Trim() } else { "" }
  if ([string]::IsNullOrWhiteSpace($normalizedName)) {
    return $null
  }

  if ($normalizedName -match "\uAC00\uC4F0\uC624\s*\uACF5\uC0AC") {
    return "https://youtu.be/eOuRDr4EpRE?si=3Qp_mUndCnQEJLZk&t=429"
  }

  return $null
}

function Get-YouTubeTimestampOverride {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Name)

  $normalizedName = if ($Name) { $Name.Trim() } else { "" }
  if ([string]::IsNullOrWhiteSpace($normalizedName)) {
    return $null
  }

  if ($normalizedName -match "가쓰오\\s*공사") {
    return "https://youtu.be/eOuRDr4EpRE?si=3Qp_mUndCnQEJLZk&t=429"
  }

  return $null
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
    $normalizedName = if ([string]::IsNullOrWhiteSpace($name)) { "" } else { $name.Trim() }
    $override = Get-YouTubeTimestampOverride -Name $normalizedName
    if ([string]::IsNullOrWhiteSpace($override)) {
      $override = Get-YouTubeTimestampOverrideFromName -Name $normalizedName
    }
    if (-not [string]::IsNullOrWhiteSpace($override)) {
      $yt = Resolve-YouTube -description $override
    }
    $youtubeFrame = $null
    if ($yt.id -and $yt.start -ne $null) {
      $youtubeFrame = Get-YoutubeTimestampFrame -VideoId $yt.id -StartSeconds $yt.start
    }

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
      youtubeFrame = $youtubeFrame
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
$places = $places | Sort-Object -Property `
  { Parse-Episode($_.category) }, `
  { if ($null -ne $_.youtubeStart) { [double]$_.youtubeStart } else { [double]::PositiveInfinity } }, `
  { $_.name }

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
