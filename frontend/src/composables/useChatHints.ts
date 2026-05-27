import { computed, type ComputedRef, type Ref } from 'vue'
import type { ChatMessage } from '@/types'
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
}

// Rule-based "what to do next" chips. First matching rule wins.
//   - empty chat (no messages, no pending project) -> two starter hints
//   - pending project queued                       -> send-to-analyze hint
//   - uploads in flight                            -> none (chips already show)
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

    return []
  })
}
