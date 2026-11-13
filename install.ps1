# Installs the orchestra skill and its two subagents into your Claude Code user folder.
# Usage: .\install.ps1 [-Force] [-DryRun]     ($env:CLAUDE_DIR overrides ~\.claude)
param([switch]$Force, [switch]$DryRun)
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$dest = if ($env:CLAUDE_DIR) { $env:CLAUDE_DIR } else { Join-Path $HOME '.claude' }

function Copy-One($from, $to) {
  if ((Test-Path $to) -and -not $Force) { Write-Host "skip   $to (exists; use -Force to overwrite)"; return }
  Write-Host "copy   $to"
  if ($DryRun) { return }
  New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
  Copy-Item $from $to -Force
}

Copy-One (Join-Path $src 'skills\orchestra\SKILL.md') (Join-Path $dest 'skills\orchestra\SKILL.md')
Copy-One (Join-Path $src 'agents\junior-haiku.md')    (Join-Path $dest 'agents\junior-haiku.md')
Copy-One (Join-Path $src 'agents\senior-opus.md')     (Join-Path $dest 'agents\senior-opus.md')
Write-Host 'Done. Start a new Claude Code session to load the skill and agents.'
