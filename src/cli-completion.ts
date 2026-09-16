/**
 * Shell completion scripts for the `branch` command. They are plain text generated here, so the
 * person can write one to a file and load it from their shell profile; nothing is installed for
 * them and no script here ever runs a Branch command to work out its suggestions.
 */
export const completionShells = ["bash", "powershell"] as const;
export type CompletionShell = (typeof completionShells)[number];

/** Every subcommand, with the options that belong to it. Also drives `branch help`. */
export const cliCommands: { name: string; summary: string; options: string[] }[] = [
  { name: "start", summary: "Run the local web app", options: [] },
  { name: "chat", summary: "Talk to the assistant in this terminal", options: ["--plain"] },
  { name: "run", summary: "Carry out one task and print the result", options: ["--json", "--attach", "--plan", "--verify", "--dry-run", "--preset", "--save-preset", "--budget", "--timeout"] },
  { name: "status", summary: "Tasks working now, questions waiting, and a health summary", options: ["--json"] },
  { name: "logs", summary: "Print what happened during one task", options: ["--json"] },
  { name: "approve", summary: "Answer a task that stopped to ask: approve <task id> yes|no", options: ["--json"] },
  { name: "completion", summary: "Print a completion script for bash or PowerShell", options: [] },
  { name: "demo", summary: "Run the offline demonstration", options: ["--json"] },
  { name: "doctor", summary: "Check that everything works", options: ["--probe", "--fix"] },
  { name: "daemon", summary: "Keep Branch working with the window closed: daemon install | uninstall | status", options: [] },
  { name: "login", summary: "Sign in to a ChatGPT account", options: [] },
  { name: "logout", summary: "Sign out of the ChatGPT account", options: [] },
  { name: "trigger", summary: "Run a schedule now", options: [] },
  { name: "backup", summary: "Write a backup file", options: [] },
  { name: "export-agent", summary: "Write the assistant itself to one file you can hand on", options: ["--memory", "--redact"] },
  { name: "import-agent", summary: "Read an assistant file: it shows what is inside, then --sections says what to bring in", options: ["--sections"] },
  { name: "restore", summary: "Read a backup file back in", options: [] },
  { name: "eval", summary: "Run the built-in evaluation set, or eval tools to check every tool", options: ["--suite", "--preset", "--compare", "--gate", "--json"] },
  { name: "study", summary: "Run a written-down experiment: study list | run <id> | compare <a> <b>", options: ["--fresh", "--json"] },
  { name: "mcp-serve", summary: "Offer Branch's tools to another AI tool", options: [] },
  { name: "acp-serve", summary: "Let a code editor talk to Branch", options: [] },
  { name: "skill", summary: "Pack a skill folder, or install a skill file: skill pack | skill install", options: ["--author", "--package-version", "--approve"] },
  { name: "plugin", summary: "See and switch plugins on or off: plugin list | enable | disable", options: [] },
  { name: "update", summary: "Update a copy installed from Git", options: [] },
];

const commandNames = (): string => cliCommands.map((command) => command.name).join(" ");
const optionsFor = (name: string): string[] => cliCommands.find((c) => c.name === name)?.options ?? [];

/** One `case` arm per subcommand, so bash suggests only that command's options. */
function bashOptionCases(): string {
  return cliCommands
    .filter((command) => command.options.length > 0)
    .map((command) => `    ${command.name}) options="${optionsFor(command.name).join(" ")}" ;;`)
    .join("\n");
}

function bashScript(): string {
  return `# Branch Agent completion for bash. Load it with: source branch-completion.bash
_branch_complete() {
  local commands="${commandNames()}"
  local current="\${COMP_WORDS[COMP_CWORD]}"
  local command="\${COMP_WORDS[1]}"
  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "\$commands" -- "\$current") )
    return
  fi
  if [ "\$command" = "completion" ] && [ "\$COMP_CWORD" -eq 2 ]; then
    COMPREPLY=( \$(compgen -W "${completionShells.join(" ")}" -- "\$current") )
    return
  fi
  if [ "\$command" = "approve" ] && [ "\$COMP_CWORD" -eq 3 ]; then
    COMPREPLY=( \$(compgen -W "yes no" -- "\$current") )
    return
  fi
  local options=""
  case "\$command" in
${bashOptionCases()}
  esac
  if [ "\${current:0:1}" = "-" ]; then
    COMPREPLY=( \$(compgen -W "\$options" -- "\$current") )
  else
    COMPREPLY=( \$(compgen -f -- "\$current") )
  fi
}
complete -F _branch_complete branch
`;
}

/** One hashtable entry per subcommand, so PowerShell suggests only that command's options. */
function powershellOptionMap(): string {
  return cliCommands
    .filter((command) => command.options.length > 0)
    .map((command) => `    '${command.name}' = @(${command.options.map((option) => `'${option}'`).join(", ")})`)
    .join("\n");
}

function powershellScript(): string {
  return `# Branch Agent completion for PowerShell. Load it with: . .\\branch-completion.ps1
Register-ArgumentCompleter -Native -CommandName branch -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $commands = @(${cliCommands.map((command) => `'${command.name}'`).join(", ")})
  $options = @{
${powershellOptionMap()}
  }
  $words = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })
  if ($words.Count -le 1 -or ($words.Count -eq 2 -and $wordToComplete)) {
    return $commands | Where-Object { $_ -like "$wordToComplete*" } |
      ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
  }
  $command = $words[1]
  if ($command -eq 'completion') {
    return @(${completionShells.map((shell) => `'${shell}'`).join(", ")}) | Where-Object { $_ -like "$wordToComplete*" } |
      ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
  }
  if ($command -eq 'approve') {
    return @('yes', 'no') | Where-Object { $_ -like "$wordToComplete*" } |
      ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
  }
  return $options[$command] | Where-Object { $_ -like "$wordToComplete*" } |
    ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`;
}

/** The completion script for one shell, or a clear error naming the shells that are supported. */
export function completionScript(shell: string): string {
  if (shell === "bash") return bashScript();
  if (shell === "powershell" || shell === "pwsh") return powershellScript();
  throw new Error(`Completion is available for: ${completionShells.join(", ")}. Try: branch completion bash`);
}

/** The usage text for `branch` with no arguments it understands. */
export function usageText(): string {
  const width = Math.max(...cliCommands.map((command) => command.name.length));
  return ["Usage: branch <command> [options]", "", ...cliCommands.map(
    (command) => `  ${command.name.padEnd(width)}  ${command.summary}`,
  ), "", "Exit codes for scripts: 0 finished, 2 stopped to ask you something, 3 failed, 4 ran out of budget."].join("\n");
}
