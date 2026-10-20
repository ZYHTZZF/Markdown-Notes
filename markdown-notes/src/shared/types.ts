export interface Profile {
  user_id: string;
  display_name: string;
  created_at: string;
  updated_at: string;
  preferences: Record<string, unknown>;
}
export interface Note {
  note_id: string;
  user_id: string;
  title: string;
  content: string;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
export interface Tag {
  tag_id: string;
  user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}
export interface NoteTag {
  note_id: string;
  tag_id: string;
  created_at: string;
}
export interface Snapshot {
  schema_version: 1;
  business_version: number;
  profile: Profile;
  notes: Note[];
  tags: Tag[];
  note_tags: NoteTag[];
}
export interface NoteView extends Note {
  tags: Tag[];
}
export interface RefSpan {
  start: number;
  end: number;
  name: string;
  key: string;
}
export interface Link {
  source_note_id: string;
  source_title: string;
  target_note_id: string | null;
  target_title_text: string;
  target_title_key: string;
  occurrence_count: number;
  status: 'valid' | 'unresolved';
  is_self: boolean;
}
export interface IndexStatus {
  state: 'ready' | 'updating' | 'rebuilding' | 'failed';
  indexed_version: number;
  business_version: number;
  epoch: string;
  phase: string;
  outage_id?: string | null;
  unavailable_ms: number;
  unavailable_total_ms: number;
  lag_commits: number;
  closure_notes: number;
  closure_bytes: number;
  barrier_attempts: number;
  barrier_ms: number;
  barrier_total_ms: number;
  wal_bytes: number;
  wal_peak_bytes: number;
  wal_growth_bytes: number;
  checkpoint_status: string;
  budget_code: string | null;
}
export interface Rpc {
  api_version: 1;
  request_id: string;
  epoch: string | null;
  method: string;
  payload: Record<string, any>;
}
export interface Reply {
  ok: boolean;
  data?: any;
  code?: string;
  message?: string;
  request_id?: string;
}
export interface Api {
  call(method: string, payload?: Record<string, any>): Promise<any>;
  onChange(fn: (event: any) => void): () => void;
  onClose(fn: () => Promise<boolean>): () => void;
}
declare global {
  interface Window {
    notesApi: Api;
  }
}
