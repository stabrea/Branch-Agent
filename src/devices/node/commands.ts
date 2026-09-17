/**
 * mac7/nodes: the operating-system programs a Branch node uses for each capability, as plain
 * argument lists. Nothing here runs anything; `actions.ts` hands these to an injectable runner, so
 * tests on any machine can check the exact command each platform would use.
 *
 * Text from the model never becomes part of a script: it is passed as a separate argument (macOS,
 * Linux) or in an environment variable the fixed script reads (Windows PowerShell).
 */
export type NodeOs = "darwin" | "linux" | "win32";
export interface OsCommand {
  executable: string;
  args: string[];
  /** Extra environment for the program: how Windows scripts receive the model's text. */
  env?: Record<string, string>;
  /** Text written to the program's input (the clipboard on macOS and Linux). */
  input?: string;
  /** The file the program writes its picture or sound to, when it makes one. */
  output?: string;
  /** Integration review: `env` is the whole environment (a walled `device.run`), not additions to the node's own. */
  exactEnv?: boolean;
}

const ps = (script: string, env: Record<string, string> = {}): OsCommand =>
  ({ executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script], env });

/** Whether a Linux session is Wayland; decides between grim/wl-clipboard and scrot/xclip. */
export const onWayland = (env: NodeJS.ProcessEnv): boolean => Boolean(env.WAYLAND_DISPLAY);

export function screenCommand(os: NodeOs, out: string, env: NodeJS.ProcessEnv): OsCommand {
  if (os === "darwin") return { executable: "screencapture", args: ["-x", "-t", "png", out], output: out };
  if (os === "linux") return onWayland(env) ? { executable: "grim", args: [out], output: out }
    : { executable: "scrot", args: ["--overwrite", out], output: out };
  return { ...ps([
    "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
    "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen",
    "$i=New-Object System.Drawing.Bitmap $b.Width,$b.Height",
    "$g=[System.Drawing.Graphics]::FromImage($i)",
    "$g.CopyFromScreen($b.Left,$b.Top,0,0,$i.Size)",
    "$i.Save($env:BRANCH_NODE_OUT,[System.Drawing.Imaging.ImageFormat]::Png)",
  ].join(";"), { BRANCH_NODE_OUT: out }), output: out };
}

/** One photo. macOS and Linux use ffmpeg, which is looked for and never installed. */
export function cameraCommand(os: NodeOs, out: string): OsCommand | null {
  if (os === "darwin") return { executable: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "avfoundation",
    "-framerate", "30", "-video_size", "1280x720", "-i", "0", "-frames:v", "1", "-y", out], output: out };
  if (os === "linux") return { executable: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "v4l2",
    "-i", "/dev/video0", "-frames:v", "1", "-y", out], output: out };
  return null;
}

/** A few seconds from the microphone. */
export function listenCommand(os: NodeOs, out: string, seconds: number): OsCommand | null {
  const length = String(Math.max(1, Math.min(30, Math.round(seconds))));
  if (os === "darwin") return { executable: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "avfoundation",
    "-i", ":0", "-t", length, "-ac", "1", "-ar", "16000", "-y", out], output: out };
  if (os === "linux") return { executable: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-f", "pulse",
    "-i", "default", "-t", length, "-ac", "1", "-ar", "16000", "-y", out], output: out };
  return null;
}

export function locationCommand(os: NodeOs): OsCommand | null {
  if (os === "linux") return { executable: "/usr/libexec/geoclue-2.0/demos/where-am-i", args: ["-t", "10"] };
  return null;
}

export function notifyCommand(os: NodeOs, title: string, body: string): OsCommand {
  if (os === "darwin") return { executable: "osascript", args: ["-e", "on run argv",
    "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "--", title, body] };
  if (os === "linux") return { executable: "notify-send", args: ["--app-name=Branch", "--", title, body] };
  return ps([
    "[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]",
    "$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$t=$x.GetElementsByTagName('text')",
    "[void]$t.Item(0).AppendChild($x.CreateTextNode($env:BRANCH_NODE_TITLE))",
    "[void]$t.Item(1).AppendChild($x.CreateTextNode($env:BRANCH_NODE_BODY))",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Branch').Show([Windows.UI.Notifications.ToastNotification]::new($x))",
  ].join(";"), { BRANCH_NODE_TITLE: title, BRANCH_NODE_BODY: body });
}

export function clipboardReadCommand(os: NodeOs, env: NodeJS.ProcessEnv): OsCommand {
  if (os === "darwin") return { executable: "pbpaste", args: [] };
  if (os === "linux") return onWayland(env) ? { executable: "wl-paste", args: ["--no-newline"] }
    : { executable: "xclip", args: ["-selection", "clipboard", "-o"] };
  return ps("Get-Clipboard -Raw");
}

export function clipboardWriteCommand(os: NodeOs, text: string, env: NodeJS.ProcessEnv): OsCommand {
  if (os === "darwin") return { executable: "pbcopy", args: [], input: text };
  if (os === "linux") return onWayland(env) ? { executable: "wl-copy", args: [], input: text }
    : { executable: "xclip", args: ["-selection", "clipboard", "-i"], input: text };
  return ps("Set-Clipboard -Value $env:BRANCH_NODE_TEXT", { BRANCH_NODE_TEXT: text });
}

/** Opens a web page in the device's browser. The address is checked to be http(s) before this. */
export function openCommand(os: NodeOs, url: string): OsCommand {
  if (os === "darwin") return { executable: "open", args: [url] };
  if (os === "linux") return { executable: "xdg-open", args: [url] };
  return ps("Start-Process -FilePath $env:BRANCH_NODE_URL", { BRANCH_NODE_URL: url });
}

export function speakCommand(os: NodeOs, text: string): OsCommand {
  if (os === "darwin") return { executable: "say", args: ["--", text] };
  if (os === "linux") return { executable: "spd-say", args: ["--wait", "--", text] };
  return ps("Add-Type -AssemblyName System.Speech;(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($env:BRANCH_NODE_TEXT)",
    { BRANCH_NODE_TEXT: text });
}

/** What a platform's node can really offer, given which programs it found. */
export const needs: Record<NodeOs, Partial<Record<string, readonly string[]>>> = {
  darwin: { camera: ["ffmpeg"], listen: ["ffmpeg"], screen: ["screencapture"], notify: ["osascript"],
    "clipboard-read": ["pbpaste"], "clipboard-write": ["pbcopy"], "open-url": ["open"], speak: ["say"], run: ["/usr/bin/sandbox-exec"] },
  linux: { camera: ["ffmpeg"], listen: ["ffmpeg"], screen: ["grim|scrot"], notify: ["notify-send"], location: ["/usr/libexec/geoclue-2.0/demos/where-am-i"],
    "clipboard-read": ["wl-paste|xclip"], "clipboard-write": ["wl-copy|xclip"], "open-url": ["xdg-open"], speak: ["spd-say"], run: ["bwrap"] },
  win32: { screen: ["powershell.exe"], notify: ["powershell.exe"], "clipboard-read": ["powershell.exe"],
    "clipboard-write": ["powershell.exe"], "open-url": ["powershell.exe"], speak: ["powershell.exe"] },
};
