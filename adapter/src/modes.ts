// Chat modes, chosen per message in the composer. Each mode other than plain
// chat routes the typed message through its slash command,
// ~/.claude/commands/<cmd>.md: auto → /tick (the self-driving harness, see
// auto-mode.ts), team → /team (Claude Code agent teams, see team-board.ts).

export type ChatMode = "chat" | "auto" | "team";

export const MODE_COMMANDS: Record<ChatMode, string | null> = { chat: null, auto: "tick", team: "team" };
export const CHAT_MODES = Object.keys(MODE_COMMANDS) as ChatMode[];

/** Route a typed message into the mode's command; slash commands pass through. */
export function modePrompt(mode: ChatMode, prompt: string): string {
  const cmd = MODE_COMMANDS[mode];
  return cmd && !prompt.trimStart().startsWith("/") ? `/${cmd} ${prompt}` : prompt;
}
