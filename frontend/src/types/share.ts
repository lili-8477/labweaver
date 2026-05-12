// frontend/src/types/share.ts
export type ArtifactKind = 'memory' | 'skill' | 'folder' | 'skill_update';
export type ShareStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'auto_rejected';

export interface ShareRequest {
  share_id: string;
  artifact_kind: ArtifactKind;
  artifact_ref: string;
  // shape varies by kind. memory:
  //   { name, description, body, type, source, hit_count, last_hit_at, facets }
  snapshot_meta: Record<string, unknown>;
  requester: string;
  reviewer: string;
  status: ShareStatus;
  requester_note: string | null;
  review_comment: string | null;
  promotion_result: Record<string, unknown> | null;
  created_at: string;     // ISO
  decided_at: string | null;
}

export interface ShareCapabilities {
  is_manager: boolean;
  manager_usernames: string[];
  pending_inbox_count: number;
  actor_username: string;
}

// Phase 2: skill snapshot shape inside snapshot_meta when artifact_kind='skill'.
export interface SkillSnapshotFile {
  path:       string;     // POSIX-style, relative to the skill dir
  sha256:     string;
  size_bytes: number;
}

export interface SkillSnapshotMeta {
  root_name: string;                 // basename of the skill folder
  manifest:  string;                 // SKILL.md contents
  files:     SkillSnapshotFile[];
}

// Phase 3: folder snapshot shape inside snapshot_meta when artifact_kind='folder'.
export interface FolderSnapshotMeta {
  root_name:   string;
  readme:      string | null;
  files:       SkillSnapshotFile[];      // reuse — same {path, sha256, size_bytes}
  total_bytes: number;
}
