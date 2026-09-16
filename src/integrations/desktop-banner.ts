import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { powerShellPath, scriptEnvironment, type DesktopScriptRunner } from './desktop-script.js';

/**
 * The small notice that sits on top of everything while the assistant is using the screen, with a
 * Stop button on it. It is a window of its own, in a process of its own, so it keeps working even
 * while the assistant is busy: pressing Stop ends that process, and Branch treats that as "stop
 * now" for the task that put the notice up.
 */
export const bannerTitle = 'Branch is using your screen';

const bannerScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Branch is using your screen'
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.Width = 460
$form.Height = 52
$form.BackColor = [System.Drawing.Color]::FromArgb(24, 24, 27)
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Left = $screen.X + [int](($screen.Width - $form.Width) / 2)
$form.Top = $screen.Y + 12

$label = New-Object System.Windows.Forms.Label
$label.Text = 'Branch is using your screen and keyboard'
$label.ForeColor = [System.Drawing.Color]::White
$label.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$label.AutoSize = $false
$label.TextAlign = 'MiddleLeft'
$label.SetBounds(16, 0, 320, 52)

$stop = New-Object System.Windows.Forms.Button
$stop.Text = 'Stop'
$stop.Name = 'Stop'
$stop.ForeColor = [System.Drawing.Color]::White
$stop.BackColor = [System.Drawing.Color]::FromArgb(185, 28, 28)
$stop.FlatStyle = 'Flat'
$stop.FlatAppearance.BorderSize = 0
$stop.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$stop.SetBounds(348, 10, 96, 32)
$stop.Add_Click({ $form.Close() })

$form.Controls.Add($label)
$form.Controls.Add($stop)
$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()
`;

export class DesktopBanner {
  private child: ChildProcess | undefined;
  private hiding = false;
  constructor(private readonly runner: DesktopScriptRunner, private readonly executable = powerShellPath) {}
  get visible(): boolean {
    return Boolean(this.child) && this.child!.exitCode === null;
  }
  /**
   * Puts the notice up, if it is not up already. `onStop` is called when the person presses Stop,
   * which happens within a moment of the click because the notice's own process ends there.
   */
  async show(onStop: () => void): Promise<void> {
    if (this.visible) return;
    const path = await this.runner.materialise('branch-banner.ps1', bannerScript);
    this.hiding = false;
    const child = spawn(this.executable, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path], {
      cwd: tmpdir(), windowsHide: true, stdio: 'ignore', env: scriptEnvironment(),
    });
    this.child = child;
    child.on('error', () => { this.child = undefined; });
    child.once('exit', () => {
      this.child = undefined;
      if (!this.hiding) onStop();
    });
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  /** Takes the notice down because the work is over, which is not the same as the person stopping it. */
  async hide(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.hiding = true;
    this.child = undefined;
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
