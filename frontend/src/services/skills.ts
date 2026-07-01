import { natsService } from './nats';
import type { SkillSummary } from '@/types/skills';

export const skillsService = {
  list: async (): Promise<SkillSummary[]> => {
    const r = await natsService.invoke('skills_list', {}) as
      { success: true; skills: SkillSummary[] };
    return r.skills;
  },

  listOrg: async (): Promise<SkillSummary[]> => {
    const r = await natsService.invoke('org_skills_list', {}) as
      { success: true; skills: SkillSummary[] };
    return r.skills;
  },

  getManifest: async (name: string): Promise<string> => {
    const r = await natsService.invoke('skill_get_manifest', { name }) as
      { success: true; manifest: string };
    return r.manifest;
  },
} as const;
