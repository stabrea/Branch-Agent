# Harness only: cuts the open HTTPS connections of the programs started from one folder, the way a
# dropped network does (the connection is reset). Needs an elevated shell. Used by real-update-windows.ps1.
param([Parameter(Mandatory = $true)][string]$Under)
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class TcpCut {
  [StructLayout(LayoutKind.Sequential)] public struct Row { public uint State, LocalAddr, LocalPort, RemoteAddr, RemotePort; }
  [DllImport("iphlpapi.dll")] public static extern int SetTcpEntry(ref Row row);
}
"@
function Port([int]$p) { [uint32]((($p -band 0xFF) -shl 8) -bor (($p -shr 8) -band 0xFF)) }  # network byte order
$pids = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$Under\*" } | ForEach-Object { $_.ProcessId }
Get-NetTCPConnection -State Established -RemotePort 443 -ErrorAction SilentlyContinue | Where-Object { $pids -contains $_.OwningProcess -and $_.RemoteAddress -notmatch ':' } | ForEach-Object {
  $row = New-Object TcpCut+Row
  $row.State = 12  # MIB_TCP_STATE_DELETE_TCB
  $row.LocalAddr = [BitConverter]::ToUInt32(([System.Net.IPAddress]::Parse($_.LocalAddress)).GetAddressBytes(), 0)
  $row.RemoteAddr = [BitConverter]::ToUInt32(([System.Net.IPAddress]::Parse($_.RemoteAddress)).GetAddressBytes(), 0)
  $row.LocalPort = Port $_.LocalPort; $row.RemotePort = Port $_.RemotePort
  "cut {0}:{1} -> {2}:{3} (pid {4}): result {5}" -f $_.LocalAddress, $_.LocalPort, $_.RemoteAddress, $_.RemotePort, $_.OwningProcess, [TcpCut]::SetTcpEntry([ref]$row)
}
