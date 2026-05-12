import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { SkillSummary } from '@/types/skills';
import { skillsService } from '@/services/skills';
import { useShareStore } from '@/stores/share';

export const useSkillsStore = defineStore('skills', () => {
  const skills    = ref<SkillSummary[]>([]);
  const orgSkills = ref<SkillSummary[]>([]);
  const loading   = ref(false);
  const error     = ref<string | null>(null);

  async function load() {
    loading.value = true;
    error.value   = null;
    try {
      const [user, org] = await Promise.all([
        skillsService.list(),
        skillsService.listOrg(),
      ]);
      skills.value    = user;
      orgSkills.value = org;
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  /** True if the given user skill name collides with an existing org skill. */
  function isOrgSkill(name: string): boolean {
    return orgSkills.value.some(s => s.name === name);
  }

  /** Delegates to useShareStore().submit. Throws on failure — caller must catch. */
  async function submitShare(name: string, note?: string) {
    const share = useShareStore();
    return await share.submit({ kind: 'skill', ref: name, note });
  }

  async function submitUpdate(name: string, note?: string) {
    const share = useShareStore();
    return await share.submit({ kind: 'skill_update', ref: name, note });
  }

  return { skills, orgSkills, loading, error, load, isOrgSkill, submitShare, submitUpdate };
});
