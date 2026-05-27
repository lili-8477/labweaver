import { natsService } from './nats';
import type { CommandSummary } from '@/types/commands';

export const commandsService = {
  list: async (): Promise<CommandSummary[]> => {
    const r = await natsService.invoke('commands_list', {}) as
      { success: true; commands: CommandSummary[] };
    return r.commands;
  },
} as const;
