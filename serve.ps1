param(
  [int]$Port = 5174
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$prefix = "http://localhost:$Port/"

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)

try {
  $listener.Start()
} catch {
  Write-Host "No se pudo abrir $prefix" -ForegroundColor Red
  Write-Host $_.Exception.Message
  Write-Host "Prueba con otro puerto:  .\serve.ps1 -Port 8080"
  exit 1
}

$mime = @{
  ".html" = "text/html; charset=utf-8"
  ".js"   = "text/javascript; charset=utf-8"
  ".mjs"  = "text/javascript; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".mp4"  = "video/mp4"
  ".webm" = "video/webm"
  ".png"  = "image/png"
  ".svg"  = "image/svg+xml"
  ".ico"  = "image/x-icon"
  ".wasm" = "application/wasm"
}

Write-Host ""
Write-Host "  Chisa - taller de hilos" -ForegroundColor Red
Write-Host "  $prefix" -ForegroundColor DarkCyan
Write-Host "  Ctrl+C para parar" -ForegroundColor DarkGray
Write-Host ""

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response

    try {
      $path = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath)
      if ([string]::IsNullOrWhiteSpace($path) -or $path -eq "/") { $path = "/index.html" }

      $full = [System.IO.Path]::GetFullPath((Join-Path $root $path.TrimStart("/")))
      $rootFull = [System.IO.Path]::GetFullPath($root)

      # /algo/ o /algo → /algo/index.html (igual que GitHub Pages)
      if ((Test-Path -LiteralPath $full -PathType Container) -or $path.EndsWith("/")) {
        $path = $path.TrimEnd("/") + "/index.html"
        $full = [System.IO.Path]::GetFullPath((Join-Path $root $path.TrimStart("/")))
      }

      if (-not $full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        $response.StatusCode = 403
        $bytes = [System.Text.Encoding]::UTF8.GetBytes("403")
      } elseif (Test-Path -LiteralPath $full -PathType Leaf) {
        $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
        $response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" }
        $response.Headers.Add("Cache-Control", "no-store")
        $bytes = [System.IO.File]::ReadAllBytes($full)
      } else {
        $response.StatusCode = 404
        $response.ContentType = "text/plain; charset=utf-8"
        $bytes = [System.Text.Encoding]::UTF8.GetBytes("404 - no encontrado: $path")
      }

      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
      try {
        $response.StatusCode = 500
        $bytes = [System.Text.Encoding]::UTF8.GetBytes("500 - " + $_.Exception.Message)
        $response.ContentLength64 = $bytes.Length
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
      } catch { }
    } finally {
      try { $response.OutputStream.Close() } catch { }
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
