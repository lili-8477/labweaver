import { computed, type ComputedRef, type Ref } from 'vue'
import type { ChatMessage, HarnessProgress } from '@/types'
import type { ChatAttachment } from '@/services/chat-attachments'
import type { CreatedProject } from '@/services/project-from-drop'

export interface Hint {
  id:   string
  text: string
}

export interface HintInputs {
  messages:       Ref<ChatMessage[]>
  attachments:    Ref<ChatAttachment[]>
  pendingProject: Ref<CreatedProject | null>
  nextSteps:      Ref<string[]>
}

// Rule-based "what to do next" chips. First matching rule wins.
//   - empty chat (no messages, no pending project) -> two starter hints
//   - pending project queued                       -> send-to-analyze hint
//   - uploads in flight                            -> none (chips already show)
//   - the agent suggested next steps               -> those
//   - otherwise                                    -> none
export function useChatHints(inputs: HintInputs): ComputedRef<Hint[]> {
  return computed<Hint[]>(() => {
    const anyUploading = inputs.attachments.value.some(a => a.state === 'uploading')
    if (anyUploading) return []

    if (inputs.pendingProject.value) {
      return [{
        id: 'send-pending-project',
        text: `Send to start analyzing ${inputs.pendingProject.value.projectName}`,
      }]
    }

    if (inputs.messages.value.length === 0) {
      return [
        { id: 'describe',  text: 'Describe what you want to do' },
        { id: 'drop-file', text: 'Drop a file to start a project' },
      ]
    }

    return inputs.nextSteps.value.map((text, i) => ({ id: `next-step-${i}`, text }))
  })
}

// The input's placeholder. In auto mode it follows the chat's progress.md, so
// the user sees what sending will do next; otherwise it's the generic prompt.
export function inputPlaceholder(auto: boolean, progress: HarnessProgress | null): string {
  if (auto) {
    const p = progress
    if (!p || p.steps.length === 0) return 'Describe the analysis. Auto mode will plan, run and review it'
    if (p.complete) return 'Project complete. Ask about the results, or start a new analysis'
    if (p.pendingFeedback > 0) return `${p.pendingFeedback} review item(s) open. Send to let auto mode fix them`
    const next = p.nextStepIndex != null ? p.steps[p.nextStepIndex] : null
    if (next) return `Next step: ${next.name}. Send to continue, or add instructions`
  }
  return 'Type a message. Drop an image to attach, or any other file to start a new project.'
}
